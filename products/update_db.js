// Step 3: UPDATE DB (Kassepris domain model)
//
// Imports normalized/*.json (produced by the fetch+normalize steps) into the
// current-offer side of the schema:
//
//   products         - one canonical row per GTIN, cross-chain, persistent
//   product_groups   - user-facing "one search result" grouping, persistent
//   store_products   - persistent (store, product) observation, upserted
//   offers           - CURRENT weekly offers only, one per (store, deal)
//   offer_products   - eligible GTIN products per current offer (mix-and-match)
//
// and replaces the previous cycle's current offers. Previous offers are
// deliberately discarded for now; offer history will be introduced later as
// a separate, designed feature.
//
// Identity: a product is keyed by its GTIN. A normalized product with no GTIN
// cannot be represented canonically and is skipped (counted) - the fetch layer
// recovers GTINs aggressively (see products/willys/fetch.js) so this is rare.
//
// Everything runs in ONE transaction. Offer replacement is scoped
// per chain (offers of stores belonging to that chain), so refreshing e.g. ICA
// never touches Coop's or Willys' current offers, and a chain whose normalized
// file is missing this run is left completely untouched.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";
import { normalizeGtin } from "./lib/gtin.js";
import { normalizedFile } from "./lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const productFiles = [
  { file: normalizedFile("coop"), slug: "coop" },
  { file: normalizedFile("ica"), slug: "ica" },
  { file: normalizedFile("willys"), slug: "willys" },
];

function extractIcaStorePathFromUrl(url) {
  const prefix = "https://www.ica.se/erbjudanden/";
  return url && url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/$/, "") : url;
}

// The retailer's regular (non-discounted) price isn't stored directly by the
// normalizer - it keeps savingsCents (amount saved vs. regular), which is null
// for chains that don't expose a regular price (Coop). original_price_cents is
// therefore price + savings when we have the saving, else null. For a multi-buy
// this is the regular price of the whole deal bundle, consistent with
// price_cents being the bundle total (see the schema's price_cents note).
function computeOriginalPriceCents(priceCents, savingsCents) {
  if (priceCents == null || savingsCents == null) return null;
  return priceCents + savingsCents;
}

// Resolves a normalized offer's `store` value to the internal store id(s) it
// applies to. Per-chain because each chain keys its offers differently:
//   coop   - by external_id (the store's "coop/<slug>/" path)
//   ica    - by the store-page url path (external_id is a bare numeric id)
//   willys - by shared newspaper assortment ("willys" / "willys-hemma"), which
//            fans out to every physical Willys store in that assortment. The
//            assortment a store belongs to is derived from its name ("Hemma"),
//            not a separate table - Willys is the one chain whose one offer
//            applies identically to many physical stores.
async function buildStoreIdsLookup(client, slug, chainId) {
  if (slug === "willys") {
    const { rows } = await client.query("SELECT id, name FROM stores WHERE chain_id = $1", [chainId]);
    const byAssortment = { willys: [], "willys-hemma": [] };
    for (const s of rows) {
      const assortment = /hemma/i.test(s.name) ? "willys-hemma" : "willys";
      byAssortment[assortment].push(s.id);
    }
    return (offerStore) => byAssortment[offerStore] ?? [];
  }

  const { rows } = await client.query("SELECT id, external_id, url FROM stores WHERE chain_id = $1", [chainId]);
  const storeIdByKey = new Map();
  for (const s of rows) {
    const key = slug === "ica" ? extractIcaStorePathFromUrl(s.url) : s.external_id.replace(/\/$/, "");
    storeIdByKey.set(key, s.id);
  }
  return (offerStore) => {
    const id = storeIdByKey.get((offerStore ?? "").replace(/\/$/, ""));
    return id ? [id] : [];
  };
}

// Removes this chain's current offers so the caller can insert this cycle's
// fresh offers. Scoped strictly to stores of `chainId`.
// offer_products rows are removed by ON DELETE CASCADE when their offer goes.
async function clearChainOffers(client, chainId) {
  const { rowCount } = await client.query(
    `DELETE FROM offers o USING stores s WHERE s.id = o.store_id AND s.chain_id = $1`,
    [chainId]
  );
  return rowCount;
}

async function importProducts() {
  const client = await pool.connect();
  const ingestedAt = new Date();

  // GTIN -> products.id, kept for the whole run so a GTIN shared across chains
  // resolves to the same canonical product row (and keeps its original group)
  // instead of being re-created per chain.
  const productIdByGtin = new Map();

  try {
    await client.query("BEGIN");

    const { rows: catRows } = await client.query("SELECT id, slug FROM categories");
    const categoryIdBySlug = new Map(catRows.map((c) => [c.slug, c.id]));

    for (const { file, slug } of productFiles) {
      if (!fs.existsSync(file)) {
        console.warn(`File not found: ${file}, skipping chain ${slug} (its current offers are left untouched)`);
        continue;
      }

      const { rows: chainRows } = await client.query("SELECT id FROM chains WHERE slug = $1", [slug]);
      if (chainRows.length === 0) {
        console.warn(`Chain "${slug}" not found in chains table, skipping.`);
        continue;
      }
      const chainId = chainRows[0].id;

      const getStoreIds = await buildStoreIdsLookup(client, slug, chainId);
      const products = JSON.parse(fs.readFileSync(file, "utf-8"));
      console.log(`Loaded ${products.length} normalized products for chain "${slug}"`);

      const removedOfferCount = await clearChainOffers(client, chainId);

      // Campaign (variant group) -> product_group id, for THIS run. A campaign
      // id is chain-scoped and rotates weekly, so it's only used to keep this
      // run's sibling variants in one group; it is never a cross-run key.
      const groupIdByCampaign = new Map();
      // offerKey -> { fields, productIds:Set }, built per chain then flushed.
      const offersByKey = new Map();

      let skippedNoGtin = 0;
      let insertedProducts = 0;
      let storeLinks = 0;
      let unmatchedStores = 0;

      for (const product of products) {
        // Treat normalized JSON as an input boundary, not a trusted database
        // key. This makes imports of older artifacts safe and guarantees every
        // lookup/insert uses the same canonical representation regardless of
        // which retailer produced it.
        const gtin = normalizeGtin(product.gtin);
        if (!gtin) {
          skippedNoGtin++;
          continue;
        }
        const categoryId = categoryIdBySlug.get(product.categorySlug);
        if (!categoryId) {
          console.warn(`Unknown category slug "${product.categorySlug}" for gtin ${gtin}, skipping product.`);
          continue;
        }

        const campaignKey = product.variantGroup ? `${slug}:${product.variantGroup}` : null;

        // Resolve the canonical product row, creating its product_group only
        // when the product is genuinely new (an existing product keeps the
        // group it was first filed under - products are persistent).
        let productId = productIdByGtin.get(gtin);
        if (!productId) {
          const existing = await client.query(
            "SELECT id, product_group_id FROM products WHERE gtin = $1",
            [gtin]
          );
          if (existing.rows.length > 0) {
            productId = existing.rows[0].id;
            if (campaignKey && !groupIdByCampaign.has(campaignKey)) {
              groupIdByCampaign.set(campaignKey, existing.rows[0].product_group_id);
            }
            // Fill in any display fields this chain has that were missing.
            await client.query(
              `UPDATE products SET
                 brand = COALESCE(brand, $2),
                 size = COALESCE(size, $3),
                 image_url = COALESCE(image_url, $4),
                 updated_at = now()
               WHERE id = $1`,
              [productId, product.brand, product.size, product.image]
            );
          } else {
            let groupId = campaignKey ? groupIdByCampaign.get(campaignKey) : undefined;
            if (!groupId) {
              const g = await client.query(
                "INSERT INTO product_groups (name, category_id) VALUES ($1, $2) RETURNING id",
                [product.title, categoryId]
              );
              groupId = g.rows[0].id;
              if (campaignKey) groupIdByCampaign.set(campaignKey, groupId);
            }
            const p = await client.query(
              `INSERT INTO products (product_group_id, gtin, title, brand, size, image_url)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [groupId, gtin, product.title, product.brand, product.size, product.image]
            );
            productId = p.rows[0].id;
            insertedProducts++;
          }
          productIdByGtin.set(gtin, productId);
        }

        // store_products (persistent membership) + accumulate current offers.
        for (const offer of product.storeOffers) {
          if (offer.priceCents == null || !offer.validUntil) continue; // offer needs a price + end date
          const storeIds = getStoreIds(offer.store);
          if (storeIds.length === 0) {
            unmatchedStores++;
            continue;
          }

          for (const storeId of storeIds) {
            await client.query(
              `INSERT INTO store_products (store_id, product_id, first_seen_at, last_seen_at)
               VALUES ($1, $2, $3, $3)
               ON CONFLICT (store_id, product_id) DO UPDATE SET last_seen_at = $3`,
              [storeId, productId, ingestedAt]
            );
            storeLinks++;

            // One offer per (store, campaign+deal) for mix-and-match, or per
            // (store, product) for a standalone offer. The key is the DEAL
            // identity (price/quantity/text/validity/membership) - deliberately
            // NOT the per-unit comparison price, which legitimately varies
            // across the variable-weight products of one campaign and is
            // aggregated into the offer's comparison min/max below instead.
            const offerKey = campaignKey
              ? [storeId, campaignKey, offer.priceCents, offer.deal, offer.validUntil, offer.isMember,
                 offer.dealQuantity, offer.unit].join("|")
              : `${storeId}|solo|${productId}`;

            let entry = offersByKey.get(offerKey);
            if (!entry) {
              entry = {
                storeId,
                priceCents: offer.priceCents,
                originalPriceCents: computeOriginalPriceCents(offer.priceCents, offer.savingsCents),
                isMember: offer.isMember ?? false,
                dealQuantity: offer.dealQuantity ?? null,
                unit: offer.unit ?? null,
                comparisonMinCents: offer.comparisonPriceMinCents ?? null,
                comparisonMaxCents: offer.comparisonPriceMaxCents ?? null,
                comparisonUnit: offer.comparisonUnit ?? null,
                dealText: offer.deal ?? null,
                moreInfo: product.moreInfo ?? null,
                validFrom: offer.validFrom ?? null, // earliest fetched start; clamped at insert
                validUntil: offer.validUntil,
                productIds: new Set(),
              };
              offersByKey.set(offerKey, entry);
            } else {
              // Widen the offer's per-unit comparison range to span every
              // product in the mix-and-match, and keep the earliest start.
              if (offer.comparisonPriceMinCents != null) {
                entry.comparisonMinCents =
                  entry.comparisonMinCents == null
                    ? offer.comparisonPriceMinCents
                    : Math.min(entry.comparisonMinCents, offer.comparisonPriceMinCents);
              }
              if (offer.comparisonPriceMaxCents != null) {
                entry.comparisonMaxCents =
                  entry.comparisonMaxCents == null
                    ? offer.comparisonPriceMaxCents
                    : Math.max(entry.comparisonMaxCents, offer.comparisonPriceMaxCents);
              }
              if (offer.validFrom && (!entry.validFrom || offer.validFrom < entry.validFrom)) {
                entry.validFrom = offer.validFrom;
              }
            }
            entry.productIds.add(productId);
          }
        }
      }

      // Flush this chain's current offers + their product eligibility.
      let insertedOffers = 0;
      let insertedOfferProducts = 0;
      for (const entry of offersByKey.values()) {
        // valid_from = the retailer's real start when it's in the past, else
        // ingestion time; never in the future, so a live offer (present in the
        // active feed we just scraped) is never hidden behind a future start.
        // Finally clamped to valid_until so the invariant valid_from <=
        // valid_until always holds even for an offer expiring the same day.
        const start = entry.validFrom ? new Date(entry.validFrom) : null;
        let validFrom = start && start < ingestedAt ? start : ingestedAt;
        const until = new Date(entry.validUntil);
        if (validFrom > until) validFrom = until;
        const { rows } = await client.query(
          `INSERT INTO offers (
             store_id, price_cents, original_price_cents, is_member, deal_quantity, unit,
             comparison_price_min_cents, comparison_price_max_cents, comparison_unit,
             deal_text, more_info, valid_from, valid_until
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [
            entry.storeId, entry.priceCents, entry.originalPriceCents, entry.isMember, entry.dealQuantity,
            entry.unit, entry.comparisonMinCents, entry.comparisonMaxCents, entry.comparisonUnit,
            entry.dealText, entry.moreInfo, validFrom, entry.validUntil,
          ]
        );
        const offerId = rows[0].id;
        insertedOffers++;
        for (const productId of entry.productIds) {
          await client.query(
            "INSERT INTO offer_products (offer_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [offerId, productId]
          );
          insertedOfferProducts++;
        }
      }

      console.log(
        `Chain "${slug}": removed ${removedOfferCount} old offers, +${insertedProducts} new products, ` +
          `${storeLinks} store links, ${insertedOffers} offers, ${insertedOfferProducts} offer-products` +
          (skippedNoGtin > 0 ? `, ${skippedNoGtin} skipped (no gtin)` : "") +
          (unmatchedStores > 0 ? `, ${unmatchedStores} unmatched store keys` : "")
      );
    }

    await client.query("COMMIT");
    console.log("Product import completed successfully.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Product import FAILED and was rolled back. Database unchanged.\n", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

importProducts();

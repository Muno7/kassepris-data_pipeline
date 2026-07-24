// Step 3: UPDATE DB
//
// Imports normalized/*.json (produced by run.js) into the product and
// store_product tables. This TRUNCATES both tables first - it's a full
// refresh, not an incremental update - so it should be run deliberately,
// not as part of an automatic pipeline, until you're confident in the data.
//
// Product identity is COALESCE(gtin, fingerprint) per chain (see
// db/schema.sql's product_chain_identity_idx) - matches on the real barcode
// when the offer has one, falls back to the text fingerprint otherwise.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const productFiles = [
  { file: path.resolve(__dirname, "coop/normalized/coop_normalized.json"), slug: "coop" },
  { file: path.resolve(__dirname, "ica/normalized/ica_normalized.json"), slug: "ica" },
  { file: path.resolve(__dirname, "willys/normalized/willys_normalized.json"), slug: "willys" },
];

function extractIcaStorePathFromUrl(url) {
  const prefix = "https://www.ica.se/erbjudanden/";
  return url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/$/, "") : url;
}

// Appends a price_history row only when price_cents actually differs from
// the most recently recorded one for this scope - keeps the log's growth
// proportional to real price movement, not to how often this script runs
// (store_product itself is fully truncated/reloaded every run and has no
// memory of "before now" - see db/schema.sql's price_history comment for
// why that's not enough for a trend/lowest-price view).
//
// scope is { storeId } for chains priced per physical store, or
// { assortmentId } for chains (Willys) where every store in the group
// shares one price - see recordPriceHistoryForOffer below for why that
// distinction exists at all.
async function recordPriceHistoryIfChanged(client, scope, productId, priceCents, comparisonPriceCents, comparisonUnit) {
  const storeId = scope.storeId ?? null;
  const assortmentId = scope.assortmentId ?? null;
  await client.query(
    `WITH last AS (
       SELECT price_cents FROM price_history
       WHERE product_id = $3 AND store_id IS NOT DISTINCT FROM $1 AND assortment_id IS NOT DISTINCT FROM $2
       ORDER BY recorded_at DESC LIMIT 1
     )
     INSERT INTO price_history (store_id, assortment_id, product_id, price_cents, comparison_price_cents, comparison_unit)
     SELECT $1, $2, $3, $4, $5, $6
     WHERE NOT EXISTS (SELECT 1 FROM last WHERE price_cents IS NOT DISTINCT FROM $4)`,
    [storeId, assortmentId, productId, priceCents, comparisonPriceCents, comparisonUnit]
  );
}

// Writes exactly one price_history entry per real price-setting event, not
// one per store row. For Willys, one storeOffer's price applies identically
// to every store in its assortment (up to 252 of them) - logging per store
// would write the same change that many times over for a single real event,
// and keep doing that forever on every future price change too (confirmed
// empirically: Willys already accounted for 12.9% of all price_history rows
// after just one run, despite being ~1.3% of the product catalog). Logging
// once per assortment instead fixes the growth rate at its source; reading
// "price history at store X" for an assortment-grouped store means looking
// it up by that store's assortment_id, not its own store_id.
async function recordPriceHistoryForOffer(client, offer, productId) {
  const scope = offer.assortmentId ? { assortmentId: offer.assortmentId } : { storeId: offer.storeIds[0] };
  await recordPriceHistoryIfChanged(client, scope, productId, offer.priceCents, offer.comparisonPriceCents, offer.comparisonUnit);
}

// Willys's storeOffers[].store is an assortment slug ("willys"/"willys-hemma"),
// not a single store's external_id - every store in that assortment shares
// the same catalog (confirmed empirically), so one storeOffer expands into a
// store_product row for every real store in the assortment, not just one.
// This keeps "products at this store" a uniform store_product join for every
// chain - no chain-specific branching needed outside this import step
// (price_history is the one place that does still need to know, see above).
async function buildStoreIdsLookup(client, slug, chainId) {
  if (slug === "willys") {
    const { rows } = await client.query(
      `SELECT s.id, a.id AS assortment_id, a.slug AS assortment_slug
       FROM stores s
       JOIN assortment a ON a.id = s.assortment_id
       WHERE s.chain_id = $1`,
      [chainId]
    );
    const byAssortmentSlug = new Map();
    for (const row of rows) {
      if (!byAssortmentSlug.has(row.assortment_slug)) {
        byAssortmentSlug.set(row.assortment_slug, { storeIds: [], assortmentId: row.assortment_id });
      }
      byAssortmentSlug.get(row.assortment_slug).storeIds.push(row.id);
    }
    return (offerStore) => byAssortmentSlug.get(offerStore) ?? { storeIds: [], assortmentId: null };
  }

  const { rows } = await client.query("SELECT id, external_id, url FROM stores WHERE chain_id = $1", [chainId]);
  const storeIdByPath = new Map();
  for (const store of rows) {
    const storePath = slug === "ica" ? extractIcaStorePathFromUrl(store.url) : store.external_id.replace(/\/$/, "");
    storeIdByPath.set(storePath, store.id);
  }
  return (offerStore) => {
    const storeId = storeIdByPath.get(offerStore.replace(/\/$/, ""));
    return { storeIds: storeId ? [storeId] : [], assortmentId: null };
  };
}

async function importProducts() {
  const client = await pool.connect();

  try {
    // product is upserted, not truncated - canonical_product_id, price
    // history, and cross-week identity continuity all depend on the same
    // row persisting week to week rather than being dropped and recreated.
    // store_product should always exactly reflect the current week's deals
    // though, so it stays a full truncate-and-reload.
    console.log("Truncating store_product table...");
    await client.query("TRUNCATE store_product");

    for (const { file, slug } of productFiles) {
      if (!fs.existsSync(file)) {
        console.warn(`File not found: ${file}, skipping chain ${slug}`);
        continue;
      }

      const { rows: chainRows } = await client.query("SELECT id FROM chain WHERE slug = $1", [slug]);
      if (chainRows.length === 0) {
        console.warn(`Chain "${slug}" not found in chain table, skipping.`);
        continue;
      }
      const chainId = chainRows[0].id;

      const getStoreIdsForOffer = await buildStoreIdsLookup(client, slug, chainId);

      const products = JSON.parse(fs.readFileSync(file, "utf-8"));
      console.log(`Loaded ${products.length} normalized products for chain "${slug}"`);

      let insertedProducts = 0;
      let insertedLinks = 0;
      let unmatchedStores = 0;

      for (const product of products) {
        const { rows } = await client.query(
          `INSERT INTO product (
             chain_id, gtin, fingerprint, variant_group, title, image, brand, size,
             more_info, badges, category_slug, category_name, raw_category_name
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (chain_id, COALESCE(gtin, fingerprint)) DO UPDATE SET
             title = EXCLUDED.title,
             variant_group = EXCLUDED.variant_group,
             image = EXCLUDED.image,
             brand = EXCLUDED.brand,
             size = EXCLUDED.size,
             more_info = EXCLUDED.more_info,
             badges = EXCLUDED.badges,
             category_slug = EXCLUDED.category_slug,
             category_name = EXCLUDED.category_name,
             raw_category_name = EXCLUDED.raw_category_name,
             updated_at = now()
           RETURNING id`,
          [
            chainId,
            product.gtin,
            product.fingerprint,
            product.variantGroup,
            product.title,
            product.image,
            product.brand,
            product.size,
            product.moreInfo,
            JSON.stringify(product.badges ?? []),
            product.categorySlug,
            product.categoryName,
            product.rawCategoryName,
          ]
        );
        const productId = rows[0].id;
        insertedProducts++;

        for (const offer of product.storeOffers) {
          const { storeIds, assortmentId } = getStoreIdsForOffer(offer.store);
          if (storeIds.length === 0) {
            unmatchedStores++;
            continue;
          }
          for (const storeId of storeIds) {
            await client.query(
              `INSERT INTO store_product (
                 store_id, product_id, price_cents, savings_cents, unit, comparison_price,
                 comparison_price_cents, comparison_unit, deal, deal_quantity, is_member, valid_until
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (store_id, product_id) DO UPDATE SET
                 price_cents = EXCLUDED.price_cents,
                 savings_cents = EXCLUDED.savings_cents,
                 unit = EXCLUDED.unit,
                 comparison_price = EXCLUDED.comparison_price,
                 comparison_price_cents = EXCLUDED.comparison_price_cents,
                 comparison_unit = EXCLUDED.comparison_unit,
                 deal = EXCLUDED.deal,
                 deal_quantity = EXCLUDED.deal_quantity,
                 is_member = EXCLUDED.is_member,
                 valid_until = EXCLUDED.valid_until`,
              [
                storeId,
                productId,
                offer.priceCents,
                offer.savingsCents,
                offer.unit,
                offer.comparisonPrice,
                offer.comparisonPriceCents,
                offer.comparisonUnit,
                offer.deal,
                offer.dealQuantity,
                offer.isMember,
                offer.validUntil,
              ]
            );
            insertedLinks++;
          }

          await recordPriceHistoryForOffer(client, { storeIds, assortmentId, ...offer }, productId);
        }
      }

      console.log(
        `Chain "${slug}": ${insertedProducts} products, ${insertedLinks} store links` +
          (unmatchedStores > 0 ? `, ${unmatchedStores} unmatched store paths` : "")
      );
    }

    console.log("Product import completed successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

importProducts();

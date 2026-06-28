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

// Willys's storeOffers[].store is an assortment slug ("willys"/"willys-hemma"),
// not a single store's external_id - every store in that assortment shares
// the same catalog (confirmed empirically), so one storeOffer expands into a
// store_product row for every real store in the assortment, not just one.
// This keeps "products at this store" a uniform store_product join for every
// chain - no chain-specific branching needed outside this import step.
async function buildStoreIdsLookup(client, slug, chainId) {
  if (slug === "willys") {
    const { rows } = await client.query(
      `SELECT s.id, a.slug AS assortment_slug
       FROM stores s
       JOIN assortment a ON a.id = s.assortment_id
       WHERE s.chain_id = $1`,
      [chainId]
    );
    const storeIdsByAssortmentSlug = new Map();
    for (const row of rows) {
      if (!storeIdsByAssortmentSlug.has(row.assortment_slug)) storeIdsByAssortmentSlug.set(row.assortment_slug, []);
      storeIdsByAssortmentSlug.get(row.assortment_slug).push(row.id);
    }
    return (offerStore) => storeIdsByAssortmentSlug.get(offerStore) ?? [];
  }

  const { rows } = await client.query("SELECT id, external_id, url FROM stores WHERE chain_id = $1", [chainId]);
  const storeIdByPath = new Map();
  for (const store of rows) {
    const storePath = slug === "ica" ? extractIcaStorePathFromUrl(store.url) : store.external_id.replace(/\/$/, "");
    storeIdByPath.set(storePath, store.id);
  }
  return (offerStore) => {
    const storeId = storeIdByPath.get(offerStore.replace(/\/$/, ""));
    return storeId ? [storeId] : [];
  };
}

async function importProducts() {
  const client = await pool.connect();

  try {
    console.log("Truncating store_product and product tables...");
    await client.query("TRUNCATE store_product, product");

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
          const storeIds = getStoreIdsForOffer(offer.store);
          if (storeIds.length === 0) {
            unmatchedStores++;
            continue;
          }
          for (const storeId of storeIds) {
            await client.query(
              `INSERT INTO store_product (
                 store_id, product_id, price_cents, unit, comparison_price, deal, is_member, valid_until
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (store_id, product_id) DO UPDATE SET
                 price_cents = EXCLUDED.price_cents,
                 unit = EXCLUDED.unit,
                 comparison_price = EXCLUDED.comparison_price,
                 deal = EXCLUDED.deal,
                 is_member = EXCLUDED.is_member,
                 valid_until = EXCLUDED.valid_until`,
              [storeId, productId, offer.priceCents, offer.unit, offer.comparisonPrice, offer.deal, offer.isMember, offer.validUntil]
            );
            insertedLinks++;
          }
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

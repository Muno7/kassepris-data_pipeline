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
];

function extractIcaStorePathFromUrl(url) {
  const prefix = "https://www.ica.se/erbjudanden/";
  return url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/$/, "") : url;
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

      const { rows: storeRows } = await client.query("SELECT id, external_id, url FROM stores WHERE chain_id = $1", [
        chainId,
      ]);
      const storeIdByPath = new Map();
      for (const store of storeRows) {
        const storePath = slug === "ica" ? extractIcaStorePathFromUrl(store.url) : store.external_id.replace(/\/$/, "");
        storeIdByPath.set(storePath, store.id);
      }

      const products = JSON.parse(fs.readFileSync(file, "utf-8"));
      console.log(`Loaded ${products.length} normalized products for chain "${slug}"`);

      let insertedProducts = 0;
      let insertedLinks = 0;
      let unmatchedStores = 0;

      for (const product of products) {
        const { rows } = await client.query(
          `INSERT INTO product (
             chain_id, gtin, fingerprint, variant_group, title, image, brand, size,
             price_cents, unit, comparison_price, deal, is_member,
             more_info, badges, category_slug, category_name, raw_category_name, valid_until
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (chain_id, COALESCE(gtin, fingerprint)) DO UPDATE SET
             title = EXCLUDED.title,
             price_cents = EXCLUDED.price_cents,
             variant_group = EXCLUDED.variant_group,
             valid_until = EXCLUDED.valid_until,
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
            product.priceCents,
            product.unit,
            product.comparisonPrice,
            product.deal,
            product.isMember,
            product.moreInfo,
            JSON.stringify(product.badges ?? []),
            product.categorySlug,
            product.categoryName,
            product.rawCategoryName,
            product.validUntil,
          ]
        );
        const productId = rows[0].id;
        insertedProducts++;

        for (const storePath of product.stores) {
          const storeId = storeIdByPath.get(storePath.replace(/\/$/, ""));
          if (!storeId) {
            unmatchedStores++;
            continue;
          }
          await client.query(
            `INSERT INTO store_product (store_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [storeId, productId]
          );
          insertedLinks++;
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

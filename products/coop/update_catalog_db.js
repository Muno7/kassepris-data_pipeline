// Step 3: UPDATE DB (general catalog, not deals)
//
// Imports normalized/coop_catalog_normalized.json into the product and
// product_online_price tables. product is upserted (not truncated) since
// it's shared with products/update_db.js's deal-sourced rows - this only
// touches the columns the catalog actually describes (title, image, brand,
// size, category), leaving deal-only columns (more_info, badges,
// variant_group) untouched so a catalog run never clobbers deal data or
// vice versa. product_online_price *is* fully replaced per chain on each
// run, since it should always reflect the latest catalog fetch exactly.
//
// Coop-only for now - ICA and Willys don't have an equivalent catalog
// fetcher yet (see the shared product/store_product design discussion this
// followed).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.resolve(__dirname, "normalized/coop_catalog_normalized.json");

async function importCoopCatalog() {
  const client = await pool.connect();

  try {
    if (!fs.existsSync(CATALOG_FILE)) {
      console.warn(`File not found: ${CATALOG_FILE}`);
      return;
    }

    const { rows: chainRows } = await client.query("SELECT id FROM chain WHERE slug = 'coop'");
    if (chainRows.length === 0) {
      console.warn(`Chain "coop" not found in chain table, skipping.`);
      return;
    }
    const chainId = chainRows[0].id;

    console.log("Clearing existing Coop online prices...");
    await client.query("DELETE FROM product_online_price WHERE product_id IN (SELECT id FROM product WHERE chain_id = $1)", [
      chainId,
    ]);

    const products = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf-8"));
    console.log(`Loaded ${products.length} normalized catalog products for chain "coop"`);

    let upsertedProducts = 0;
    let upsertedPrices = 0;

    for (const product of products) {
      const { rows } = await client.query(
        `INSERT INTO product (
           chain_id, gtin, fingerprint, title, image, brand, size,
           category_slug, category_name, raw_category_name
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (chain_id, COALESCE(gtin, fingerprint)) DO UPDATE SET
           title = EXCLUDED.title,
           image = EXCLUDED.image,
           brand = EXCLUDED.brand,
           size = EXCLUDED.size,
           category_slug = EXCLUDED.category_slug,
           category_name = EXCLUDED.category_name,
           raw_category_name = EXCLUDED.raw_category_name,
           updated_at = now()
         RETURNING id`,
        [
          chainId,
          product.gtin,
          product.fingerprint,
          product.title,
          product.image,
          product.brand,
          product.size,
          product.categorySlug,
          product.categoryName,
          product.rawCategoryName,
        ]
      );
      const productId = rows[0].id;
      upsertedProducts++;

      await client.query(
        `INSERT INTO product_online_price (product_id, price_cents, comparison_price, fetched_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (product_id) DO UPDATE SET
           price_cents = EXCLUDED.price_cents,
           comparison_price = EXCLUDED.comparison_price,
           fetched_at = now()`,
        [productId, product.priceCents, product.comparisonPrice]
      );
      upsertedPrices++;
    }

    console.log(`Chain "coop": ${upsertedProducts} products upserted, ${upsertedPrices} online prices set.`);
    console.log("Catalog import completed successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

importCoopCatalog();

// Imports stores/willys/willys_stores.json (Coop/ICA have their own
// stores/update_db.js now - this script is Willys-only, kept for its
// assortment-assignment logic). Unlike Coop/ICA's upsert-based update_db.js,
// this still deletes-and-reloads, since Willys store data rarely changes and
// this predates the upsert approach - fine to leave as-is.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORES_FILE = path.resolve(__dirname, "../willys/willys_stores.json");

async function importWillysStores() {
  const client = await pool.connect();

  try {
    if (!fs.existsSync(STORES_FILE)) {
      console.warn(`File not found: ${STORES_FILE}`);
      return;
    }

    const { rows: chainRows } = await client.query("SELECT id FROM chain WHERE slug = 'willys'");
    if (chainRows.length === 0) {
      console.warn(`Chain "willys" not found in chain table - run db/schema.sql first.`);
      return;
    }
    const chainId = chainRows[0].id;

    const { rows: assortmentRows } = await client.query("SELECT id, slug FROM assortment WHERE chain_id = $1", [
      chainId,
    ]);
    const assortmentIdBySlug = new Map(assortmentRows.map((r) => [r.slug, r.id]));
    if (!assortmentIdBySlug.has("willys") || !assortmentIdBySlug.has("willys-hemma")) {
      console.warn(`Missing "willys"/"willys-hemma" assortment rows - run db/schema.sql first.`);
      return;
    }

    console.log("Deleting existing Willys stores...");
    await client.query("DELETE FROM stores WHERE chain_id = $1", [chainId]);

    const stores = JSON.parse(fs.readFileSync(STORES_FILE, "utf-8"));
    console.log(`Loaded ${stores.length} Willys stores`);

    let insertedCount = 0;
    for (const store of stores) {
      const assortmentId = store.name.toLowerCase().includes("hemma")
        ? assortmentIdBySlug.get("willys-hemma")
        : assortmentIdBySlug.get("willys");

      try {
        await client.query(
          `INSERT INTO stores (chain_id, assortment_id, external_id, name, url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (external_id) DO NOTHING`,
          [chainId, assortmentId, store.code, store.name, store.url]
        );
        insertedCount++;
      } catch (err) {
        console.warn(`Failed to insert store "${store.name}" (code: ${store.code}):`, err.message);
      }
    }

    console.log(`Inserted ${insertedCount}/${stores.length} Willys stores.`);
  } finally {
    client.release();
    await pool.end();
  }
}

importWillysStores();

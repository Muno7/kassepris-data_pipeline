// Imports stores/willys/willys_stores.json into the stores table (Willys-only;
// Coop/ICA have their own stores/update_db.js). Willys store data rarely
// changes, so this is a plain upsert keyed on (chain_id, external_id).
//
// There is no assortment table anymore: which shared newspaper assortment a
// Willys store follows ("willys" vs "willys-hemma") is derived from its name
// at product-ingestion time (see products/update_db.js's buildStoreIdsLookup),
// so nothing about that grouping needs to be persisted here.

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

    const { rows: chainRows } = await client.query("SELECT id FROM chains WHERE slug = 'willys'");
    if (chainRows.length === 0) {
      console.warn(`Chain "willys" not found in chains table - run db/schema.sql first.`);
      return;
    }
    const chainId = chainRows[0].id;

    const stores = JSON.parse(fs.readFileSync(STORES_FILE, "utf-8"));
    console.log(`Loaded ${stores.length} Willys stores`);

    let upserted = 0;
    for (const store of stores) {
      try {
        await client.query(
          `INSERT INTO stores (chain_id, external_id, name, url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chain_id, external_id) DO UPDATE SET
             name = EXCLUDED.name,
             url = EXCLUDED.url,
             updated_at = now()`,
          [chainId, store.code, store.name, store.url]
        );
        upserted++;
      } catch (err) {
        console.warn(`Failed to insert store "${store.name}" (code: ${store.code}):`, err.message);
      }
    }

    console.log(`Upserted ${upserted}/${stores.length} Willys stores.`);
  } finally {
    client.release();
    await pool.end();
  }
}

importWillysStores();

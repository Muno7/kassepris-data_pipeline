// Step 2: UPDATE DB
//
// Upserts stores/data/{chain}_stores.json into the stores table, keyed on
// external_id. This is a plain upsert (insert new stores, refresh existing
// ones) - not a truncate-and-reload - because stores are referenced by
// product/store_product via foreign keys, and store identity should stay
// stable across runs.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");

const storeFiles = [
  { file: path.join(DATA_DIR, "coop_stores.json"), slug: "coop" },
  { file: path.join(DATA_DIR, "ica_stores.json"), slug: "ica" },
];

async function upsertStores() {
  const client = await pool.connect();
  try {
    for (const { file, slug } of storeFiles) {
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

      const stores = JSON.parse(fs.readFileSync(file, "utf-8"));
      let upserted = 0;

      for (const store of stores) {
        await client.query(
          `INSERT INTO stores (chain_id, external_id, name, url, address, city, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (external_id) DO UPDATE SET
             name = EXCLUDED.name,
             url = EXCLUDED.url,
             address = EXCLUDED.address,
             city = EXCLUDED.city,
             latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude,
             updated_at = now()`,
          [chainId, store.external_id, store.name, store.url, store.address, store.city, store.latitude, store.longitude]
        );
        upserted++;
      }

      console.log(`Chain "${slug}": ${upserted} stores upserted.`);
    }
    console.log("Store import completed successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

upsertStores();

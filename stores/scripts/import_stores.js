import fs from "fs";
import path from "path";
import { Pool } from "pg";
import dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: path.resolve("../../.env") });
const DATABASE_URL = process.env.DB_URL;

if (!DATABASE_URL) {
  console.error("Error: DATABASE_URL is undefined. Check your .env file.");
  process.exit(1);
}

// JSON files for each chain
const storeFiles = [
  { file: "../willys/willys_stores.json", slug: "willys" },
  { file: "../coop/coop_stores.json", slug: "coop" },
  { file: "../ica/ica_stores.json", slug: "ica" },
];

async function importStores() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    // 1. Delete all rows in the stores table
    console.log("Deleting all rows from stores table...");
    await client.query("DELETE FROM stores");
    console.log("All rows deleted successfully.");

    // 2. Loop through each chain's JSON file
    for (const { file, slug } of storeFiles) {
      const filePath = path.resolve(file);

      if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}, skipping chain ${slug}`);
        continue;
      }

      const stores = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      console.log(`Loaded ${stores.length} stores for chain "${slug}"`);

      // Log duplicate external_ids
      const codes = stores.map((s) => s.code);
      const duplicates = codes.filter((v, i, a) => a.indexOf(v) !== i);
      if (duplicates.length > 0) {
        console.log("Duplicate external_ids:", [...new Set(duplicates)]);
      }

      // Get chain_id
      const { rows: chainRows } = await client.query(
        "SELECT id FROM chain WHERE slug = $1",
        [slug]
      );
      if (chainRows.length === 0) {
        console.warn(`Chain "${slug}" not found in chain table, skipping.`);
        continue;
      }
      const chainId = chainRows[0].id;

      // For Willys: fetch assortments and build a map
      let willysAssortmentsMap = {};
      if (slug === "willys") {
        const res = await client.query(
          "SELECT id, slug FROM assortment WHERE chain_id = $1",
          [chainId]
        );
        for (const row of res.rows) {
          willysAssortmentsMap[row.slug] = row.id;
        }
      }

      // Insert each store with optional assortment
      let insertedCount = 0;
      for (const store of stores) {
        try {
          let assortmentId = null;

          // Assign assortment only for Willys
          if (slug === "willys") {
            if (store.name.toLowerCase().includes("hemma")) {
              assortmentId = willysAssortmentsMap["hemma"];
            } else {
              assortmentId = willysAssortmentsMap["standard"];
            }
          }

          await client.query(
            `INSERT INTO stores (chain_id, assortment_id, external_id, name, url)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (external_id) DO NOTHING`,
            [chainId, assortmentId, store.code, store.name, store.url]
          );
          insertedCount++;
        } catch (err) {
          console.warn(
            `Failed to insert store "${store.name}" (code: ${store.code}):`,
            err.message
          );
        }
      }

      console.log(`Inserted ${insertedCount}/${stores.length} stores for chain "${slug}"`);
    }

    console.log("Store import completed successfully.");
  } catch (err) {
    console.error("Unexpected error during import:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the import
importStores();

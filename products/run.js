import { fetchAllCoopStores } from "./coop/fetch.js";
import { normalizeAllCoopStores } from "./coop/normalize.js";
import { fetchAllIcaStores } from "./ica/fetch.js";
import { normalizeAllIcaStores } from "./ica/normalize.js";
import { pool } from "../db/pool.js";

console.log("=== Step 1/4: Fetching Coop ===");
await fetchAllCoopStores();
console.log("\n=== Step 2/4: Normalizing Coop ===");
normalizeAllCoopStores();
console.log("\n=== Step 3/4: Fetching ICA ===");
await fetchAllIcaStores();
console.log("\n=== Step 4/4: Normalizing ICA ===");
normalizeAllIcaStores();

await pool.end();
console.log("\nAll done. Run update_db.js to import normalized/*.json into the database.");

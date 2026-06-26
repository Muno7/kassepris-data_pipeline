import { fetchCoopStores } from "./coop/fetch.js";
import { fetchIcaStores } from "./ica/fetch.js";

console.log("=== Step 1/2: Fetching Coop stores ===");
await fetchCoopStores();
console.log("\n=== Step 2/2: Fetching ICA stores ===");
await fetchIcaStores();

console.log("\nAll done. Run update_db.js to upsert stores/data/*.json into the stores table.");

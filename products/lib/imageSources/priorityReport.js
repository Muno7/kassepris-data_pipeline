// Step 5: ranks missing_images by real shopper-facing traffic instead of
// raw miss count, and exports the top N as a CSV for manual image sourcing
// (supplier press kits, own photography) - a manual follow-up task, not
// something this script automates further.
//
// There's no search-query log in this schema to rank by "how often
// searched", so traffic is approximated from what the schema does track:
// how many stores currently carry the product (store_products - breadth),
// how many times it's been the subject of a current or historical deal
// (offer_products / historical_offer_products - the moments it's actually
// shown on a deals page), and how many backfill runs in a row still missed
// it (lookup_count - a gap that keeps recurring is more worth fixing than
// one that might resolve itself once a source's export catches up).
//
// Deal appearances are weighted heaviest since that's the most direct proxy
// for "a shopper is looking at this exact product right now."

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "../../../config/env.js";
import { pool } from "../../../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOP_N = Number(process.argv[2] ?? 50);
const OUTPUT_FILE = path.resolve(__dirname, "missing-images-priority.csv");

// Each count is aggregated in its own LATERAL subquery rather than by joining
// all three tables and de-duplicating afterwards. The three are independent
// one-to-many relations off the same product, so joining them together
// multiplies rather than combines: a product in 1000 stores with 50 current
// and 200 historical offers produces 1000 x 50 x 200 = 10M intermediate rows
// that count(DISTINCT ...) then collapses back to three numbers. Summed over
// the whole missing_images set that does not finish in useful time.
//
// count(*) rather than count(DISTINCT ...) inside each subquery because
// (store_id, product_id), (offer_id, product_id) and (historical_offer_id,
// product_id) are the respective primary keys - one row per pair already, so
// the DISTINCT was only ever undoing the damage the join fan-out caused.
// Each subquery is a range scan on the existing (product_id, ...) index.
const QUERY = `
  SELECT
    mi.gtin,
    mi.product_name,
    mi.category,
    mi.lookup_count,
    sp.store_count,
    op.current_offer_count,
    hop.historical_offer_count,
    (sp.store_count
      + op.current_offer_count * 5
      + hop.historical_offer_count * 2
      + mi.lookup_count) AS traffic_score
  FROM missing_images mi
  CROSS JOIN LATERAL (
    SELECT count(*) AS store_count
    FROM store_products s WHERE s.product_id = mi.product_id
  ) sp
  CROSS JOIN LATERAL (
    SELECT count(*) AS current_offer_count
    FROM offer_products o WHERE o.product_id = mi.product_id
  ) op
  CROSS JOIN LATERAL (
    SELECT count(*) AS historical_offer_count
    FROM historical_offer_products h WHERE h.product_id = mi.product_id
  ) hop
  ORDER BY traffic_score DESC
  LIMIT $1
`;

function toCsvRow(fields) {
  return fields
    .map((f) => {
      const s = f == null ? "" : String(f);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

async function run() {
  const { rows } = await pool.query(QUERY, [TOP_N]);

  const header = [
    "gtin", "product_name", "category", "traffic_score",
    "store_count", "current_offer_count", "historical_offer_count", "lookup_count",
  ];
  const lines = [toCsvRow(header), ...rows.map((r) => toCsvRow([
    r.gtin, r.product_name, r.category, r.traffic_score,
    r.store_count, r.current_offer_count, r.historical_offer_count, r.lookup_count,
  ]))];

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n") + "\n");
  console.log(`[imageSources] Wrote top ${rows.length} priority gaps -> ${OUTPUT_FILE}`);
  await pool.end();
}

run();

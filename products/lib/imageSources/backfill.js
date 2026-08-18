// Step 1+2+4 of the image-licensing migration: resolves a licensed image for
// every product currently missing one (or run with --all to re-resolve
// everything, e.g. after a source export refresh), via the tiered fallback
// OFF -> OPF -> OBF -> placeholder, and writes the result straight into
// products.image_url (hotlinked, no download/re-host - see README).
//
// Uses DuckDB purely as a local join engine against the exports downloaded
// by downloadExports.js (read-only ATTACH to Postgres for that join), then
// writes results back through the normal `pg` pool, one transaction for the
// whole run - consistent with update_db.js elsewhere in this codebase.
//
// "Already resolved" tracking deliberately lives in JS (a Set of product
// ids), not in a per-tier SQL WHERE on image_source: DuckDB's ATTACH is a
// separate Postgres connection from the `pg` client doing the writes, and a
// separate connection can't see another one's uncommitted changes (normal
// MVCC) - so a tier-2 query filtering on image_source IS NULL would still
// see tier 1's matches as unresolved and redo them. Tracking resolution
// in-process side-steps that entirely instead of relying on cross-session
// read-your-own-writes visibility that doesn't exist here.
//
// Naturally resumable across process runs: a plain rerun only considers
// products whose image_source is still NULL from the last committed run.
// --all forces every product through resolution again (e.g. after
// downloading fresher exports) regardless of current state.

import path from "path";
import { fileURLToPath } from "url";
import "../../../config/env.js";
import { pool } from "../../../db/pool.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { SOURCES, exportPath } from "./sources.js";
import { buildImageUrl, pickFrontImage } from "./urls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORCE_ALL = process.argv.includes("--all");

async function openDuckDb() {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL postgres; LOAD postgres;");
  await conn.run(`ATTACH '${process.env.DB_URL}' AS pgdb (TYPE postgres, READ_ONLY)`);
  return conn;
}

// Every product in Postgres joined against one source's local export on the
// zero-padded barcode - unfiltered by resolution state, since that's
// tracked in JS (see file header). Products present in the export but
// without a usable front image fall through to the next tier, same as
// products absent from the export entirely - from here they're
// indistinguishable, which is correct: neither one gave us an image.
async function findMatches(conn, source) {
  const reader = await conn.runAndReadAll(`
    SELECT p.id, p.gtin, src.images
    FROM pgdb.products p
    JOIN read_ndjson('${exportPath(source)}', columns={code: 'VARCHAR', images: 'JSON'}, ignore_errors=true) src
      ON src.code = lpad(p.gtin, 13, '0')
  `);

  const matches = [];
  for (const row of reader.getRowObjects()) {
    // DuckDB's JSON column comes back through the Node bindings as a
    // JSON-encoded string, not a parsed value - an unparsed string
    // silently satisfies no optional-chained property access in
    // pickFrontImage, so skipping this parse makes every row look like "no
    // image" instead of erroring (confirmed the hard way on the first run).
    const front = pickFrontImage(JSON.parse(row.images));
    if (!front) continue;
    matches.push({
      // DuckDB returns Postgres uuid columns as a DuckDBUUIDValue object,
      // not a string - left un-stringified, `candidateIds.has(m.id)` back
      // in backfill() would never match the plain-string ids the `pg`
      // client works with, and every match would look like "not a
      // candidate" regardless of pickFrontImage's result (confirmed the
      // hard way: this cost a second all-zero run after the JSON-parse fix).
      id: String(row.id),
      url: buildImageUrl(source.imageDomain, row.gtin, front.lang, front.rev),
      width: front.width,
      height: front.height,
    });
  }
  return matches;
}

async function writeResolved(client, source, resolved) {
  for (const r of resolved) {
    await client.query(
      `UPDATE products SET
         image_url_legacy = COALESCE(image_url_legacy, image_url),
         image_url = $2,
         image_source = $3,
         image_license = $4,
         image_resolved_at = now(),
         image_width = $5,
         image_height = $6
       WHERE id = $1`,
      [r.id, r.url, source.key, source.license, r.width, r.height]
    );
  }
}

// Whatever's left after every tier failed: strip the old (copyrighted)
// image_url entirely rather than leaving it in place - see README on why a
// missing image is preferred over a liability - and record it in
// missing_images as the manual-sourcing priority queue.
async function markPlaceholders(client, products) {
  for (const p of products) {
    await client.query(
      `UPDATE products SET
         image_url_legacy = COALESCE(image_url_legacy, image_url),
         image_url = NULL,
         image_source = 'placeholder',
         image_license = NULL,
         image_resolved_at = now(),
         image_width = NULL,
         image_height = NULL
       WHERE id = $1`,
      [p.id]
    );
    await client.query(
      `INSERT INTO missing_images (product_id, gtin, product_name, category)
       SELECT $1, $2, $3, c.name
       FROM product_groups pg JOIN categories c ON c.id = pg.category_id
       WHERE pg.id = $4
       ON CONFLICT (product_id) DO UPDATE SET
         last_seen_at = now(),
         lookup_count = missing_images.lookup_count + 1`,
      [p.id, p.gtin, p.title, p.product_group_id]
    );
  }
  return products.length;
}

async function backfill() {
  const conn = await openDuckDb();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: allProducts } = await client.query(
      "SELECT id, gtin, title, product_group_id FROM products"
    );
    const candidateIds = FORCE_ALL
      ? new Set(allProducts.map((p) => p.id))
      : new Set(allProducts.filter((p) => p.image_source == null).map((p) => p.id));
    console.log(`[imageSources] ${candidateIds.size} of ${allProducts.length} products need resolution`);

    const resolvedIds = new Set();
    for (const source of SOURCES) {
      console.log(`[imageSources] Resolving against ${source.label}...`);
      const matches = await findMatches(conn, source);
      const fresh = matches.filter((m) => candidateIds.has(m.id) && !resolvedIds.has(m.id));
      await writeResolved(client, source, fresh);
      for (const m of fresh) resolvedIds.add(m.id);
      console.log(`[imageSources] ${source.label}: resolved ${fresh.length} products`);
    }

    const byId = new Map(allProducts.map((p) => [p.id, p]));
    const stillMissing = [...candidateIds].filter((id) => !resolvedIds.has(id)).map((id) => byId.get(id));
    const placeholders = await markPlaceholders(client, stillMissing);
    console.log(`[imageSources] ${placeholders} products still unresolved -> placeholder + missing_images`);

    await client.query("COMMIT");
    console.log("[imageSources] Backfill committed.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[imageSources] Backfill FAILED and was rolled back.\n", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await backfill();
}

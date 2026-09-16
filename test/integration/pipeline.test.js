// Integration test: run the REAL pipeline against a small sample (a few seeded
// stores, fetched live) into the disposable test Postgres, then assert the
// structural invariants that must hold for ANY valid data - so weekly offer
// changes never cause a false failure. This is the automation of what was
// previously verified by hand after each change.
//
// Requires: APP_ENV=test + the test Postgres up (docker compose up -d db).
// Run via `npm run test:integration` or the full `npm test`.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { pool, resetSchema, seedStores, count } from "../helpers/db.js";
import { runStep, FETCH_AND_NORMALIZE, LOAD } from "../helpers/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "../fixtures/stores.json");

describe("pipeline (sample live fetch -> ingest)", () => {
  let dataRoot;
  let offersAfterFirstLoad;
  let productsAfterFirstLoad;

  before(async () => {
    // Fail fast with a clear message if the test DB isn't reachable.
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      throw new Error(`test Postgres not reachable - run \`docker compose up -d db\` first.\n${err.message}`);
    }

    await resetSchema();
    await seedStores(FIXTURE);

    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kassepris-test-"));
    for (const step of FETCH_AND_NORMALIZE) runStep(step, dataRoot);
    runStep(LOAD, dataRoot);

    offersAfterFirstLoad = await count("SELECT count(*) n FROM offers");
    productsAfterFirstLoad = new Map(
      (await pool.query("SELECT gtin, id FROM products")).rows.map((row) => [row.gtin, row.id])
    );
  });

  after(async () => {
    if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true });
    await pool.end();
  });

  it("produced data (the sample fetch actually ingested)", async () => {
    assert.ok((await count("SELECT count(*) n FROM products")) > 0, "no products ingested");
    assert.ok(offersAfterFirstLoad > 0, "no offers ingested");
    assert.ok((await count("SELECT count(*) n FROM store_products")) > 0, "no store_products");
  });

  it("business rule: a product is never in two current offers at the same store", async () => {
    const violations = await count(`
      SELECT count(*) n FROM (
        SELECT o.store_id, op.product_id
        FROM offer_products op JOIN offers o ON o.id = op.offer_id
        GROUP BY o.store_id, op.product_id HAVING count(*) > 1
      ) x`);
    assert.equal(violations, 0);
  });

  it("comparison price: min <= max always, and real ranges are preserved", async () => {
    const inverted = await count(
      "SELECT count(*) n FROM offers WHERE comparison_price_min_cents > comparison_price_max_cents"
    );
    assert.equal(inverted, 0, "min > max should never happen");
    const ranges = await count(
      "SELECT count(*) n FROM offers WHERE comparison_price_max_cents > comparison_price_min_cents"
    );
    assert.ok(ranges > 0, "expected some real comparison ranges (Coop has many)");
  });

  it("validity window: valid_from is never in the future or after valid_until", async () => {
    const bad = await count(
      "SELECT count(*) n FROM offers WHERE valid_from > now() OR valid_from > valid_until"
    );
    assert.equal(bad, 0);
  });

  it("mix-and-match: offers spanning multiple products exist", async () => {
    const multi = await count(
      "SELECT count(*) n FROM (SELECT offer_id FROM offer_products GROUP BY offer_id HAVING count(*) > 1) x"
    );
    assert.ok(multi > 0, "expected at least one multi-product (campaign) offer");
  });

  it("referential integrity: every offer/store_product maps to a real store & product", async () => {
    assert.equal(await count("SELECT count(*) n FROM products WHERE product_group_id IS NULL"), 0);
    assert.equal(
      await count(
        "SELECT count(*) n FROM offers o LEFT JOIN stores s ON s.id = o.store_id WHERE s.id IS NULL"
      ),
      0
    );
    assert.equal(
      await count(
        "SELECT count(*) n FROM offer_products op LEFT JOIN products p ON p.id = op.product_id WHERE p.id IS NULL"
      ),
      0
    );
  });

  it("replacement: a second load replaces current offers without duplicating products", async () => {
    runStep(LOAD, dataRoot); // re-ingest the same normalized data
    const offersNow = await count("SELECT count(*) n FROM offers");
    assert.equal(offersNow, offersAfterFirstLoad, "current offers replaced, not doubled");
    const productsNow = new Map(
      (await pool.query("SELECT gtin, id FROM products")).rows.map((row) => [row.gtin, row.id])
    );
    assert.deepEqual(productsNow, productsAfterFirstLoad, "GTIN products should persist across offer refreshes");
    assert.equal(
      await count(`
        SELECT count(*) n FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('historical_offers', 'historical_offer_products')
      `),
      0,
      "offer history tables should not exist"
    );
  });
});

// Opt-in full production-shaped test. It uses a dedicated persistent local
// Docker database. A manually reset database is bootstrapped with db:init and
// its first refresh; an existing one receives the update-only production path.
//
// It deliberately is not part of `npm test`: live discovery plus every store's
// offers is a long-running retailer-dependent operation. Run it explicitly:
//   npm run test:production-e2e

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { count, pool } from "../helpers/db.js";
import { normalizeGtin } from "../../products/lib/gtin.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT_MS = 60 * 60 * 1000;
// A second refresh normally runs against the same weekly retailer feeds. A
// material drop is therefore evidence of failed stores/pages, not ordinary
// week-to-week offer variation. Keep this deliberately high: a smaller drop
// should make the production-shaped check fail loudly for investigation.
const MIN_COVERAGE_RETAINED = 0.95;

function runDocker(args) {
  try {
    execFileSync("docker", [
      "compose",
      "-p",
      "kassepris-production-test",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.production-test.yml",
      ...args,
    ], {
      cwd: REPO,
      stdio: "inherit",
      timeout: TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(`production E2E Docker step failed: docker compose ${args.join(" ")}\n${err.message}`);
  }
}

async function currentCoverage() {
  const { rows } = await pool.query(`
    SELECT c.slug,
           count(DISTINCT s.id)::int AS stores,
           count(DISTINCT o.id)::int AS offers,
           count(DISTINCT op.product_id)::int AS offered_products,
           count(op.product_id)::int AS offer_product_links,
           count(DISTINCT s.id) FILTER (WHERE o.id IS NOT NULL)::int AS stores_with_offers
    FROM chains c
    LEFT JOIN stores s ON s.chain_id = c.id
    LEFT JOIN offers o ON o.store_id = s.id
    LEFT JOIN offer_products op ON op.offer_id = o.id
    GROUP BY c.slug
    ORDER BY c.slug
  `);
  return rows;
}

function assertCoverageIsUsable(coverage) {
  assert.deepEqual(
    coverage.map((row) => row.slug),
    ["coop", "ica", "willys"]
  );
  for (const row of coverage) {
    assert.ok(row.stores > 0, `${row.slug} has no stores`);
    assert.ok(row.offers > 0, `${row.slug} has no current offers`);
    assert.ok(row.offered_products > 0, `${row.slug} has no products attached to current offers`);
    assert.ok(row.offer_product_links >= row.offers, `${row.slug} has offers without product links`);
    assert.ok(row.stores_with_offers > 0, `${row.slug} has no stores with current offers`);
  }
}

function assertCoverageRetained(before, after) {
  const afterBySlug = new Map(after.map((row) => [row.slug, row]));
  for (const previous of before) {
    const next = afterBySlug.get(previous.slug);
    assert.ok(next, `${previous.slug} disappeared from the refreshed database`);
    for (const field of ["offers", "offered_products", "offer_product_links", "stores_with_offers"]) {
      const minimum = Math.ceil(previous[field] * MIN_COVERAGE_RETAINED);
      assert.ok(
        next[field] >= minimum,
        `${previous.slug} ${field} fell from ${previous[field]} to ${next[field]} ` +
          `(${((next[field] / previous[field]) * 100).toFixed(1)}%; minimum ${MIN_COVERAGE_RETAINED * 100}%)`
      );
    }
  }
}

async function assertDataIntegrity() {
  assert.equal(await count("SELECT count(*) n FROM products WHERE gtin IS NULL"), 0);
  assert.equal(
    await count("SELECT count(*) n FROM (SELECT gtin FROM products GROUP BY gtin HAVING count(*) > 1) duplicates"),
    0
  );
  assert.equal(
    await count("SELECT count(*) n FROM offers WHERE price_cents <= 0 OR valid_from > valid_until"),
    0,
    "current offers contain an invalid price or date range"
  );
  assert.equal(
    await count(`
      SELECT count(*) n
      FROM offers o
      WHERE NOT EXISTS (SELECT 1 FROM offer_products op WHERE op.offer_id = o.id)
    `),
    0,
    "current offers exist without eligible products"
  );
  assert.equal(
    await count(`
      SELECT count(*) n
      FROM offer_products op
      JOIN products p ON p.id = op.product_id
      WHERE p.gtin IS NULL
    `),
    0,
    "a current offer is linked to a product without a GTIN"
  );

  const { rows: gtins } = await pool.query("SELECT gtin FROM products");
  for (const { gtin } of gtins) {
    assert.equal(normalizeGtin(gtin), gtin, `product GTIN is not a canonical valid GTIN: ${gtin}`);
  }

  assert.ok((await count("SELECT count(*) n FROM products")) > 0, "no products imported");
  assert.ok((await count("SELECT count(*) n FROM store_products")) > 0, "no store-product observations imported");
  assert.ok((await count("SELECT count(*) n FROM offer_products")) > 0, "no offer-product links imported");
}

async function assertGtinOfferLookupWorks() {
  // This is the query shape the application ultimately needs: take only a
  // canonical GTIN and retrieve its current offers, including retailer/store.
  const { rows: candidateRows } = await pool.query(`
    SELECT p.gtin
    FROM products p
    JOIN offer_products op ON op.product_id = p.id
    JOIN offers o ON o.id = op.offer_id
    LIMIT 1
  `);
  assert.equal(candidateRows.length, 1, "no GTIN is queryable through current offers");

  const gtin = candidateRows[0].gtin;
  const { rows } = await pool.query(`
    SELECT p.id AS product_id, p.gtin, c.slug AS chain, s.id AS store_id,
           o.id AS offer_id, o.price_cents, o.valid_from, o.valid_until
    FROM products p
    JOIN offer_products op ON op.product_id = p.id
    JOIN offers o ON o.id = op.offer_id
    JOIN stores s ON s.id = o.store_id
    JOIN chains c ON c.id = s.chain_id
    WHERE p.gtin = $1
  `, [gtin]);

  assert.ok(rows.length > 0, `GTIN ${gtin} did not resolve to any current offers`);
  for (const row of rows) {
    assert.equal(row.gtin, gtin);
    assert.ok(row.chain && row.store_id && row.offer_id);
    assert.ok(row.price_cents > 0);
  }
}

describe("production-shaped full refresh", { skip: !process.env.RUN_PRODUCTION_E2E }, () => {
  it("bootstraps a fresh database or refreshes an existing one without replacing products", { timeout: TIMEOUT_MS }, async () => {
    try {
      const hasProductsTable = (
        await pool.query("SELECT to_regclass('public.products') IS NOT NULL AS exists")
      ).rows[0].exists;

      if (!hasProductsTable) {
        // This is the manual-reset bootstrap path. One app container performs
        // init and its first refresh, so artifacts survive to the importer.
        runDocker(["run", "--rm", "app", "bash", "-lc", "npm run db:init && npm run products:update-all"]);
      }

      const firstCoverage = await currentCoverage();
      assertCoverageIsUsable(firstCoverage);
      await assertDataIntegrity();
      await assertGtinOfferLookupWorks();

      const firstProducts = new Map(
        (await pool.query("SELECT gtin, id FROM products")).rows.map((row) => [row.gtin, row.id])
      );

      // This mirrors a scheduled production task. Its artifacts are freshly
      // fetched in a new container; it does not initialize or reset the DB.
      runDocker(["run", "--rm", "app", "npm", "run", "products:update-all"]);

      const productsAfterRefresh = new Map(
        (await pool.query("SELECT gtin, id FROM products")).rows.map((row) => [row.gtin, row.id])
      );
      for (const [gtin, id] of firstProducts) {
        assert.equal(productsAfterRefresh.get(gtin), id, `product identity changed for GTIN ${gtin}`);
      }
      assert.equal(
        await count(`
          SELECT count(*) n FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename IN ('historical_offers', 'historical_offer_products')
        `),
        0,
        "offer history tables are intentionally not part of the current schema"
      );

      const refreshedCoverage = await currentCoverage();
      assertCoverageIsUsable(refreshedCoverage);
      assertCoverageRetained(firstCoverage, refreshedCoverage);
      await assertDataIntegrity();
      await assertGtinOfferLookupWorks();
    } finally {
      await pool.end();
    }
  });
});

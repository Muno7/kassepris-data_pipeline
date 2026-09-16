// Test-database helpers. The pool comes from the app's own db/pool.js, so it
// honours APP_ENV/DB_URL exactly like production - run the suite with
// APP_ENV=test so this points at the disposable Postgres (docker-compose.yml),
// never a real database.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");

// resetSchema drops every table, so this guard is the line between a test run
// and a data-loss incident: refuse anything that isn't clearly the throwaway
// test database.
function assertTestDb() {
  const url = process.env.DB_URL || "";
  if (!/kassepris_(test|production_test)|:543[34](\/|\b)/.test(url)) {
    throw new Error(
      `Refusing to reset a non-test database (DB_URL=${url.replace(/:[^:@/]*@/, ":<pw>@")}). ` +
        `Run tests with APP_ENV=test so DB_URL points at the disposable Postgres from docker-compose.yml.`
    );
  }
}

export { pool };

// Fresh, canonical schema every run - drop the whole public schema and re-apply
// db/schema.sql (which also seeds chains + categories). Deterministic and fast.
export async function resetSchema() {
  assertTestDb();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  const schema = fs.readFileSync(path.join(REPO, "db/schema.sql"), "utf-8");
  await pool.query(schema);
}

// Seed just the sample stores the fetchers will pull offers for. Coop/ICA read
// their store list from the DB, so seeding N here is what bounds the fetch to N
// (that's the "sample" - the whole point of not fetching all ~2300 stores).
export async function seedStores(fixturePath) {
  const stores = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  for (const s of stores) {
    await pool.query(
      `INSERT INTO stores (chain_id, external_id, name, url, city, latitude, longitude)
       SELECT id, $2, $3, $4, $5, $6, $7 FROM chains WHERE slug = $1
       ON CONFLICT (chain_id, external_id) DO NOTHING`,
      [s.chain, s.external_id, s.name, s.url, s.city, s.latitude, s.longitude]
    );
  }
  return stores.length;
}

// Scalar count helper for assertions: count(sql) -> number.
export async function count(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].n);
}

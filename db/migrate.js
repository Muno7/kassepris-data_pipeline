// One-shot migration runner: applies db/migration.sql (reshape + drop legacy
// tables, preserving stores + chains) immediately followed by db/schema.sql
// (create the new Kassepris tables + seed categories) inside a SINGLE
// transaction, so the whole redesign is atomic - either the database ends up
// fully on the new schema, or nothing changes.
//
// Product/offer/price data is intentionally dropped and re-fetched afterwards
// (npm run products:update-all). Only stores + chains are carried across.
//
// BACK UP FIRST. This drops tables. e.g.  pg_dump "$DB_URL" -f backup.sql
// Then:  node db/migrate.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationSql = fs.readFileSync(path.resolve(__dirname, "migration.sql"), "utf-8");
const schemaSql = fs.readFileSync(path.resolve(__dirname, "schema.sql"), "utf-8");

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Applying migration (reshape + drop legacy) and schema (create new) in one transaction...");
    await client.query("BEGIN");
    await client.query(migrationSql);
    await client.query(schemaSql);
    await client.query("COMMIT");
    console.log("Migration committed.\n");

    const { rows } = await client.query(`
      SELECT table_name,
             (xpath('/row/c/text()',
                    query_to_xml(format('SELECT count(*) c FROM %I', table_name), false, true, '')))[1]::text::int AS rows
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    console.log("Tables now present:");
    for (const r of rows) console.log(`  ${r.table_name.padEnd(28)} ${r.rows} rows`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nMigration FAILED and was rolled back. Database unchanged.\n", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();

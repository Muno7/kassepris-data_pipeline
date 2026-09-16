// Applies db/schema.sql to the configured database (idempotent - safe to run
// on an already-initialized DB). Node-native so it needs no `psql` binary,
// which keeps the Docker image slim and lets `db:init` run inside the
// container.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = fs.readFileSync(path.resolve(__dirname, "schema.sql"), "utf-8");

try {
  await pool.query(schemaSql);
  console.log("Schema applied.");
} catch (err) {
  console.error("Schema apply failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}

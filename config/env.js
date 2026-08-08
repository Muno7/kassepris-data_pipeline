// Central environment resolution for every entrypoint (fetchers, importers,
// db pool). One place decides which environment we're in and which .env file
// backs it, so a script never has to care - it just reads process.env.
//
// APP_ENV selects a profile: development (default) | test | production.
//   development - your local machine + local Postgres; fetchers run fast with
//                 no politeness delay (you're not a production scraper yet).
//   test        - CI / automated tests against a DISPOSABLE Postgres (see
//                 docker-compose.yml). Never SQLite/in-memory: the schema is
//                 Postgres-specific (uuid, pg_trgm, xpath, gen_random_uuid).
//   production  - the deployed job against AWS RDS (SSL on) with polite fetch
//                 pacing that respects each chain's rate limits.
//
// Env files are layered: `.env.<APP_ENV>` is loaded first and wins, then the
// base `.env` fills in anything shared (e.g. API keys common to all envs).
// dotenv does not override already-set vars, so first-listed wins. Real
// production secrets are injected by the deploy environment, not committed.

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || "development";

// Loaded once, on first import, before anyone reads process.env.DB_URL etc.
dotenv.config({ path: [path.join(ROOT, `.env.${APP_ENV}`), path.join(ROOT, ".env")] });

export const IS_PRODUCTION = APP_ENV === "production";
export const IS_TEST = APP_ENV === "test";

// Postgres over SSL is required for AWS RDS. Defaults on in production, off
// elsewhere, but always overridable with DB_SSL for e.g. a TLS-enabled local.
export const DB_SSL = (process.env.DB_SSL ?? (IS_PRODUCTION ? "true" : "false")).toLowerCase() === "true";

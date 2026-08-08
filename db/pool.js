import { Pool } from "pg";
import { DB_SSL } from "../config/env.js";

// Importing config/env.js has already loaded the right .env file for APP_ENV,
// so DB_URL and DB_SSL are populated before this runs. SSL is on for AWS RDS
// in production; rejectUnauthorized is relaxed since RDS uses its own CA chain
// (set DB_SSL_REJECT_UNAUTHORIZED=true once the RDS CA bundle is wired in).
const rejectUnauthorized = (process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "false").toLowerCase() === "true";

export const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: DB_SSL ? { rejectUnauthorized } : false,
});

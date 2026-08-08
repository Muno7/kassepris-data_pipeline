// Central place for every ingestion script's environment-driven config, so
// credentials and tuning knobs (concurrency, retry counts, delays) live
// outside the source and can be changed per-deployment without touching
// code - and so a missing/malformed value fails loudly at startup with a
// clear cause, instead of surfacing later as a confusing runtime error.

// Environment (.env file selection per APP_ENV) is resolved centrally in
// config/env.js, imported here for its load side-effect so process.env is
// populated before any getEnvInt/requireEnv call below runs.
export { APP_ENV, IS_PRODUCTION, IS_TEST } from "../../config/env.js";

// For values a script genuinely cannot run without (API keys) - stops
// startup immediately with a clear cause, rather than letting a blank key
// silently reach every request and fail there instead, one confusing error
// at a time.
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name} (check .env)`);
  return value;
}

// For tuning knobs that have a sane default (concurrency, retry counts) -
// safe to omit in .env, but still validated so a typo'd value (e.g. "ten"
// instead of "10") is caught at startup instead of silently becoming NaN
// somewhere downstream.
export function getEnvInt(name, fallback) {
  const value = process.env[name];
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  return parsed;
}

// One real browser UA shared by every fetcher, so every request looks like
// an ordinary visitor's browser rather than a distinctive, easily-filtered
// client string - not for concealment of what the traffic is, just to avoid
// standing out from normal visitor traffic on user-agent alone.
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

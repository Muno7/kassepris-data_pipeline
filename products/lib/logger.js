// Minimal structured logger shared by every ingestion script. Each line is a
// single JSON object (easy to grep/pipe into a log aggregator later) plus a
// human-readable line on stdout during interactive runs. Level filtering via
// LOG_LEVEL (default "info") - set to "debug" to see per-request detail.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

// The one place every log line actually gets formatted and emitted, so
// switching output format (or shipping to a real log pipeline later)
// touches one function, not every call site.
function log(level, scope, message, fields = {}) {
  if (LEVELS[level] < currentLevel) return;
  const entry = { time: new Date().toISOString(), level, scope, message, ...fields };
  const line = `[${entry.time}] ${level.toUpperCase()} ${scope}: ${message}` +
    (Object.keys(fields).length ? " " + JSON.stringify(fields) : "");
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

// Gives each ingestion script (or module within one) its own tagged logger,
// so log lines are traceable back to their source without passing a scope
// string to every individual call.
export function createLogger(scope) {
  return {
    debug: (message, fields) => log("debug", scope, message, fields),
    info: (message, fields) => log("info", scope, message, fields),
    warn: (message, fields) => log("warn", scope, message, fields),
    error: (message, fields) => log("error", scope, message, fields),
  };
}

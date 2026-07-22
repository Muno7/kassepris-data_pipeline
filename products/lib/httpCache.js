// File-based HTTP response cache, keyed by request URL.
//
// Coop's API never sends an ETag or Last-Modified header (confirmed
// empirically against both the store-list and offers endpoints), so true
// conditional requests (If-None-Match / If-Modified-Since -> 304) aren't
// something the server actually supports today - this client still sends
// those headers whenever a cached entry happens to carry them, so it works
// automatically if that ever changes, but the mechanism doing real work
// right now is the offers endpoint's own `Cache-Control: max-age=900` - a
// cached entry is considered fresh (skip the network call entirely) until
// that TTL elapses, falling back to a configurable default when a response
// carries no Cache-Control header at all.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000; // matches Coop offers' own max-age=900

// Turns a URL into a safe, fixed-length filename - so cache entries can live
// as flat files without worrying about query strings or length limits.
function keyFor(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

// Reads the server's own stated freshness window off a cached response, so
// "how long is this good for" comes from the server that issued it rather
// than being guessed here.
function parseMaxAgeMs(cacheControl) {
  const match = cacheControl?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) * 1000 : null;
}

export function createHttpCache(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });

  function entryPath(url) {
    return path.join(cacheDir, `${keyFor(url)}.json`);
  }

  return {
    // Returns the cached entry (fresh or stale) so the caller can still send
    // conditional headers on a stale entry, or null if nothing is cached.
    get(url) {
      const file = entryPath(url);
      if (!fs.existsSync(file)) return null;
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },

    // The actual "is it safe to skip the network call" decision - this is
    // what turns a cache entry from "something we saved" into "something we
    // can trust right now".
    isFresh(entry, defaultTtlMs = DEFAULT_TTL_MS) {
      if (!entry) return false;
      const ttlMs = parseMaxAgeMs(entry.headers?.["cache-control"]) ?? defaultTtlMs;
      return Date.now() - entry.fetchedAt < ttlMs;
    },

    // Persists a successful response for next time, keeping only the
    // headers that future requests actually need (conditional-request
    // headers, freshness) rather than the full response header set.
    set(url, { status, body, headers }) {
      const entry = {
        url,
        status,
        body,
        headers: {
          etag: headers.get("etag") ?? undefined,
          "last-modified": headers.get("last-modified") ?? undefined,
          "cache-control": headers.get("cache-control") ?? undefined,
        },
        fetchedAt: Date.now(),
      };
      fs.writeFileSync(entryPath(url), JSON.stringify(entry));
      return entry;
    },
  };
}

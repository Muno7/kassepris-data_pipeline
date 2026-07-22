// Resilient fetch wrapper shared by every ingestion script: retries with
// exponential backoff, adaptive rate limiting, local response caching,
// structured logging, and metrics - so each chain's fetch.js only has to
// describe *what* to fetch and how to map it, not how to fetch it safely.

import { createHttpCache } from "./httpCache.js";

// Only the statuses that mean "try again later" - a real 4xx like 404 or
// 400 will never succeed on retry, so it's deliberately excluded here (see
// the non-retryable-vs-thrown-error split in fetchRaw below).
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Some chains (ICA) publish their actual rate budget via standard
// RateLimit-* response headers - reading that is strictly better than
// guessing a fixed delay, since it tells us exactly how much room is left
// instead of finding out by getting throttled. Chains that don't send these
// headers (Coop, Willys) just get null here and fall back to the
// success/failure-driven pacing below.
function parseRateLimitHeaders(headers) {
  const remaining = headers?.get?.("ratelimit-remaining");
  const resetSeconds = headers?.get?.("ratelimit-reset");
  if (remaining == null || resetSeconds == null) return null;
  return { remaining: Number(remaining), resetSeconds: Number(resetSeconds) };
}

// Serializes request *starts* across every concurrent worker sharing this
// client to one minimum spacing, so "concurrency" (how many requests may be
// in flight at once) and "rate" (how fast new ones may start) are controlled
// independently. Absent any server feedback, the spacing adapts on its own:
// multiplicative backoff on 429/5xx/network errors, gradual additive
// recovery on sustained success (back off fast, recover slowly) - and when a
// server *does* publish its remaining budget, that takes precedence over the
// guess, since it's ground truth rather than an inference.
function createRateGate({ minDelayMs, maxDelayMs, stepDownMs }) {
  let currentDelayMs = minDelayMs;
  let nextAvailableAt = 0;

  return {
    async acquire() {
      const now = Date.now();
      const waitMs = Math.max(0, nextAvailableAt - now);
      nextAvailableAt = Math.max(now, nextAvailableAt) + currentDelayMs;
      if (waitMs > 0) await sleep(waitMs);
    },
    onThrottled() {
      currentDelayMs = Math.min(maxDelayMs, Math.max(currentDelayMs * 2, 250));
    },
    onSuccess() {
      currentDelayMs = Math.max(minDelayMs, currentDelayMs - stepDownMs);
    },
    onRateLimitInfo({ remaining, resetSeconds }) {
      if (!Number.isFinite(remaining) || !Number.isFinite(resetSeconds)) return;
      if (remaining <= 0) {
        // Budget exhausted for this window - there's nothing to do but wait
        // it out, so jump straight to that instead of failing forward into
        // an inevitable 429.
        currentDelayMs = Math.min(maxDelayMs, resetSeconds * 1000);
        return;
      }
      // Spread whatever's left evenly across the rest of the window. Only
      // raises the delay, never lowers it below what onSuccess/onThrottled
      // already decided - the server's number is a ceiling on how fast we
      // may go, not a floor forcing us to go that fast.
      const safePacingMs = (resetSeconds * 1000) / remaining;
      currentDelayMs = Math.max(currentDelayMs, Math.min(maxDelayMs, safePacingMs));
    },
    get currentDelayMs() {
      return currentDelayMs;
    },
  };
}

export function createHttpClient({
  name,
  logger,
  metrics,
  cacheDir,
  maxRetries = 4,
  baseBackoffMs = 500,
  maxBackoffMs = 15000,
  minDelayMs = 0,
  maxDelayMs = 10000,
  stepDownMs = 50,
  defaultTtlMs,
  requestTimeoutMs = 30000,
}) {
  const cache = cacheDir ? createHttpCache(cacheDir) : null;
  const gate = createRateGate({ minDelayMs, maxDelayMs, stepDownMs });

  // Single HTTP attempt, including the conditional-request headers a fresh
  // cache entry can supply - separated from the retry loop so that loop
  // reads as "keep trying until it works", not tangled up with what one
  // attempt actually involves. The timeout matters as much as the retry
  // logic itself: a connection that never responds (as opposed to one that
  // errors quickly) would otherwise hang this attempt - and the worker slot
  // it's running in - forever, since plain fetch() has no default timeout.
  // Aborting turns that silent hang into an ordinary retryable failure.
  async function attemptOnce(url, options, cachedEntry) {
    const headers = { ...options.headers };
    if (cachedEntry?.headers?.etag) headers["If-None-Match"] = cachedEntry.headers.etag;
    if (cachedEntry?.headers?.["last-modified"]) headers["If-Modified-Since"] = cachedEntry.headers["last-modified"];

    const startedAt = Date.now();
    const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(requestTimeoutMs) });
    const durationMs = Date.now() - startedAt;

    if (res.status === 304 && cachedEntry) {
      metrics?.recordCacheHit();
      metrics?.recordRequest({ status: 304, durationMs, payloadBytes: 0 });
      logger?.debug("304 not modified, using cache", { url, durationMs });
      return { status: 304, body: cachedEntry.body, durationMs, fromCache: true, headers: res.headers };
    }

    const body = await res.text();
    metrics?.recordRequest({ status: res.status, durationMs, payloadBytes: Buffer.byteLength(body) });

    if (res.ok) {
      cache?.set(url, { status: res.status, body, headers: res.headers });
    }
    return { status: res.status, body, durationMs, fromCache: false, headers: res.headers };
  }

  // The actual resilience loop (cache-first, then retry-with-backoff on
  // failure) - kept response-format-agnostic so both fetchJson and
  // fetchText below can share one implementation of "make this succeed"
  // instead of each re-implementing retry/cache/rate-limit handling.
  async function fetchRaw(url, options = {}) {
    const cachedEntry = cache?.get(url);
    if (cachedEntry && cache.isFresh(cachedEntry, defaultTtlMs)) {
      metrics?.recordCacheHit();
      logger?.debug("cache hit (fresh)", { url });
      return { body: cachedEntry.body, status: cachedEntry.status, fromCache: true, durationMs: 0 };
    }

    // A thrown exception here (network failure, DNS, connection reset) and
    // a deliberately non-retryable status (404, 400, ...) are different
    // situations and need different handling - a dead URL should fail once
    // and stop, not burn through every retry with backoff on a request that
    // will never succeed. Keeping them in one try/catch made every
    // non-retryable status look like a transient failure worth retrying.
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await gate.acquire();

      let result;
      try {
        result = await attemptOnce(url, options, cachedEntry);
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          gate.onThrottled();
          metrics?.recordRetry();
          const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
          logger?.warn("request failed, retrying", { url, attempt, error: err.message, backoffMs: Math.round(backoff) });
          await sleep(backoff);
        }
        continue;
      }

      if (result.status === 304 || (result.status >= 200 && result.status < 300)) {
        gate.onSuccess();
        const rateInfo = parseRateLimitHeaders(result.headers);
        if (rateInfo) gate.onRateLimitInfo(rateInfo);
        return { body: result.body, status: result.status, fromCache: result.fromCache, durationMs: result.durationMs };
      }

      if (RETRYABLE_STATUS.has(result.status) && attempt < maxRetries) {
        gate.onThrottled();
        metrics?.recordRetry();
        const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
        logger?.warn("retryable status, backing off", { url, status: result.status, attempt, backoffMs: Math.round(backoff) });
        await sleep(backoff);
        continue;
      }

      // Either a non-retryable status, or a retryable one with no attempts
      // left - either way, further looping can't help.
      lastError = new Error(`Non-retryable response: ${result.status} for ${url}`);
      break;
    }

    metrics?.recordFailure();
    logger?.error("request failed", { url, error: lastError?.message });
    throw lastError ?? new Error(`Request failed: ${url}`);
  }

  return {
    // For chains whose endpoint returns JSON directly (Coop, Willys).
    async fetchJson(url, options = {}) {
      const result = await fetchRaw(url, options);
      return { ...result, data: JSON.parse(result.body) };
    },
    // For chains where the useful data is embedded inside an HTML page
    // (ICA server-renders its offers into the page rather than exposing an
    // API) - same resilience behavior, just without assuming the body is
    // JSON, so the caller can pull whatever it needs out of the raw text.
    async fetchText(url, options = {}) {
      const result = await fetchRaw(url, options);
      return { ...result, text: result.body };
    },
  };
}

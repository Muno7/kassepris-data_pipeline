// Accumulates counters/timings across an ingestion run and renders the final
// report requested for every fetch script: request counts, cache hits,
// retries, failures, average response time, payload sizes, schema changes.

export function createMetrics(name) {
  const state = {
    name,
    startedAt: Date.now(),
    requests: 0,
    cacheHits: 0,
    retries: 0,
    failures: 0,
    validationFailures: 0,
    responseTimesMs: [],
    payloadBytes: [],
    statusCounts: {},
    schemaChanges: [],
  };

  return {
    recordRequest({ status, durationMs, payloadBytes }) {
      state.requests++;
      state.responseTimesMs.push(durationMs);
      if (payloadBytes != null) state.payloadBytes.push(payloadBytes);
      state.statusCounts[status] = (state.statusCounts[status] ?? 0) + 1;
    },
    recordCacheHit() {
      state.cacheHits++;
    },
    recordRetry() {
      state.retries++;
    },
    recordFailure() {
      state.failures++;
    },
    recordValidationFailure() {
      state.validationFailures++;
    },
    recordSchemaChange(change) {
      state.schemaChanges.push(change);
    },
    // Prints (and returns) the run's health summary - the thing that lets
    // "did this scheduled run actually work?" be answered by reading its
    // own output, rather than having to infer it from silence or dig
    // through raw logs.
    report() {
      const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const sum = (arr) => arr.reduce((a, b) => a + b, 0);
      const durationSec = ((Date.now() - state.startedAt) / 1000).toFixed(1);

      const lines = [
        ``,
        `=== Ingestion report: ${state.name} ===`,
        `Duration:            ${durationSec}s`,
        `Requests:            ${state.requests}`,
        `Cache hits:          ${state.cacheHits}`,
        `Retries:             ${state.retries}`,
        `Failures:            ${state.failures}`,
        `Validation failures: ${state.validationFailures}`,
        `Avg response time:   ${avg(state.responseTimesMs).toFixed(0)}ms`,
        `Total payload:       ${(sum(state.payloadBytes) / 1024 / 1024).toFixed(2)}MB`,
        `Avg payload size:    ${(avg(state.payloadBytes) / 1024).toFixed(1)}KB`,
        `Status codes:        ${JSON.stringify(state.statusCounts)}`,
        `Schema changes:      ${state.schemaChanges.length === 0 ? "none" : state.schemaChanges.join("; ")}`,
        ``,
      ];
      const text = lines.join("\n");
      console.log(text);
      return { ...state, durationSec: Number(durationSec) };
    },
  };
}

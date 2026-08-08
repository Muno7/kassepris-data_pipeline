// Lets every ingestion script bound how many fetches run at once, without
// each chain's fetch.js re-implementing its own worker pool - a fetch script
// deals in "what to do per item", not "how many at a time", and tuning that
// number (Coop can take 10, ICA's edge protection wants far fewer) should be
// a one-line config change, not a copy-pasted loop to edit three times.
export async function runWithConcurrency(items, limit, worker, { onFailure, onProgress, progressEvery = 100 } = {}) {
  let cursor = 0;
  let ok = 0;
  let failed = 0;

  async function next() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await worker(item);
        ok++;
      } catch (err) {
        failed++;
        onFailure?.(item, err);
      }
      if (onProgress && (ok + failed) % progressEvery === 0) onProgress(ok + failed, items.length);
    }
  }

  await Promise.all(Array.from({ length: limit }, next));
  return { ok, failed };
}

// Same as runWithConcurrency, but re-runs whatever failed in additional passes
// before giving up - so a store/category that failed on a transient error
// (network blip, a 5xx that outlived the per-request retries in httpClient)
// gets another chance instead of silently dropping out of the dataset. The
// per-request retry in httpClient handles within-a-request flakiness; this
// handles a whole unit of work that still failed after that. Returns the
// leftover failedItems so the caller can decide whether a partial result is
// acceptable (e.g. Willys throws; Coop/ICA report and continue).
export async function runWithRetries(
  items,
  limit,
  worker,
  { onFailure, onProgress, progressEvery = 100, maxRetryPasses = 2, onRetryPass } = {}
) {
  let pending = items;
  let okTotal = 0;

  for (let pass = 0; ; pass++) {
    const failedItems = [];
    const { ok } = await runWithConcurrency(pending, limit, worker, {
      onFailure: (item, err) => {
        failedItems.push(item);
        onFailure?.(item, err, pass);
      },
      onProgress,
      progressEvery,
    });
    okTotal += ok;

    if (failedItems.length === 0 || pass >= maxRetryPasses) {
      return { ok: okTotal, failed: failedItems.length, failedItems };
    }
    onRetryPass?.(pass + 1, failedItems.length);
    pending = failedItems;
  }
}

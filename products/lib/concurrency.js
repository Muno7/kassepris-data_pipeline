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

// Crash-recovery checkpointing for a single ingestion run: tracks which item
// ids (e.g. store external_ids) already completed successfully, so a run
// interrupted partway through (crash, killed process, network outage) can
// resume without re-fetching everything from scratch. Not a cross-run cache
// - a full successful run clears its checkpoint, since each scheduled
// ingestion is meant to be a fresh snapshot (see products/lib/httpCache.js
// for the separate, actually-cross-run response cache).

import fs from "fs";
import path from "path";

export function createCheckpoint(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Picks up wherever a prior run of this same script left off - an empty
  // set here just means "starting fresh", not an error.
  let done = new Set();
  if (fs.existsSync(filePath)) {
    try {
      done = new Set(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch {
      done = new Set();
    }
  }

  // Written after every single item, not batched, so the checkpoint is
  // never more than one item stale if the process dies unexpectedly.
  function persist() {
    fs.writeFileSync(filePath, JSON.stringify([...done]));
  }

  return {
    // Lets a worker skip re-fetching something a prior, interrupted run of
    // this script already finished.
    isDone(id) {
      return done.has(id);
    },
    // Records one more item as safe to skip on a future resume.
    markDone(id) {
      done.add(id);
      persist();
    },
    // How much of this run was already done before it started - the signal
    // that tells a caller "this is a resume", not a fresh run.
    get resumedCount() {
      return done.size;
    },
    // Called once a run finishes cleanly, so the *next* run starts fresh
    // instead of skipping everything forever.
    clear() {
      done = new Set();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    },
  };
}

// Downloads (or refreshes) the three Open-*-Facts bulk exports to
// exports/*.jsonl.gz. Run this before backfill.js, and again periodically
// as new products show up in our own catalog - the exports are regenerated
// nightly upstream, so re-running this is how a rerun picks up anything
// newly photographed/added on their end since the last download.
//
// Downloaded once to local disk rather than queried remotely each run:
// these are gzipped JSONL, not an indexed format like Parquet, so every
// query has to stream-decompress the *entire* file regardless of how
// selective the filter is - not repeating that transfer on every rerun is
// the whole point of caching them locally. See README.md for the size/cost
// tradeoff this was chosen over (Parquet would allow remote range-request
// queries, but the public Parquet host rate-limits anonymous access).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { SOURCES, exportPath } from "./sources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.resolve(__dirname, "exports");

async function downloadOne(source) {
  const dest = exportPath(source);
  console.log(`[imageSources] Downloading ${source.label} export...`);
  const res = await fetch(source.exportUrl);
  if (!res.ok) throw new Error(`${source.label} export download failed: HTTP ${res.status}`);
  const tmp = `${dest}.tmp`;
  await pipeline(res.body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  const { size } = fs.statSync(dest);
  console.log(`[imageSources] ${source.label}: ${(size / 1e6).toFixed(1)} MB -> ${dest}`);
}

export async function downloadAllExports() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  for (const source of SOURCES) {
    await downloadOne(source);
  }
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await downloadAllExports();
}

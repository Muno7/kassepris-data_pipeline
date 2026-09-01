// Runs the real ingestion pipeline as subprocesses, exactly as production does
// (npm run products:update-all), but pointed at:
//   - the test database (APP_ENV=test)
//   - a throwaway data directory (PIPELINE_DATA_ROOT) so a sample run never
//     touches your real products/*/data working files.
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// One subprocess per real entrypoint. run.js does Coop+ICA fetch+normalize;
// Willys and the DB load are their own scripts. Each is the same command the
// production pipeline runs.
export const FETCH_AND_NORMALIZE = [
  "products/run.js",
  "products/willys/fetch.js",
  "products/willys/normalize.js",
];
export const LOAD = "products/update_db.js";

export function runStep(scriptRelPath, dataRoot) {
  try {
    execFileSync("node", [scriptRelPath], {
      cwd: REPO,
      env: { ...process.env, APP_ENV: "test", PIPELINE_DATA_ROOT: dataRoot },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    const out = ((err.stdout && err.stdout.toString()) || "") + ((err.stderr && err.stderr.toString()) || "");
    throw new Error(`pipeline step failed: node ${scriptRelPath}\n--- last output ---\n${out.split("\n").slice(-30).join("\n")}`);
  }
}

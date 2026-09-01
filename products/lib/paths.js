// Where the pipeline reads/writes its per-chain scraped data, normalized
// output, and run checkpoints. Defaults to products/<chain>/{data,normalized,
// .state} in the repo. Set PIPELINE_DATA_ROOT to relocate the whole tree - the
// test suite points it at a throwaway temp dir so a sample run never touches
// your real working data.
import path from "path";
import { fileURLToPath } from "url";

const PRODUCTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.PIPELINE_DATA_ROOT ? path.resolve(process.env.PIPELINE_DATA_ROOT) : PRODUCTS_DIR;

export const dataDir = (chain) => path.join(ROOT, chain, "data");
export const normalizedDir = (chain) => path.join(ROOT, chain, "normalized");
export const normalizedFile = (chain) => path.join(normalizedDir(chain), `${chain}_normalized.json`);
export const stateDir = (chain) => path.join(ROOT, chain, ".state");

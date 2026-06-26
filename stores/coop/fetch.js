// Step 1: FETCH (Coop stores)
//
// One bulk request lists every Coop store (name, url, ledgerAccountNumber).
// A second request per store (same proxy.api.coop.se host) returns its
// address/city/lat/lng. No browser, no scraping - both are plain JSON APIs.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const OUTPUT_FILE = path.join(DATA_DIR, "coop_stores.json");

// The per-store detail endpoint rate-limits much more aggressively than the
// offers API does, so this needs the same throttling treatment as ICA.
const CONCURRENCY = 3;
const DELAY_MS = 200;
const MAX_RETRIES = 3;

const STORE_INFO_SUBSCRIPTION_KEY = "990520e65cc44eef89e9e9045b57f4e9";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStoreList() {
  const res = await fetch("https://proxy.api.coop.se/external/store/stores?api-version=v5", {
    headers: { "Ocp-Apim-Subscription-Key": STORE_INFO_SUBSCRIPTION_KEY, Accept: "application/json" },
  });
  const data = await res.json();
  return data.stores.filter((s) => s.url);
}

async function fetchStoreDetail(ledgerAccountNumber) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(DELAY_MS);
    const res = await fetch(`https://proxy.api.coop.se/external/store/stores/${ledgerAccountNumber}?api-version=v5`, {
      headers: { "Ocp-Apim-Subscription-Key": STORE_INFO_SUBSCRIPTION_KEY, Accept: "application/json" },
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(DELAY_MS * attempt * 4);
      continue;
    }
    throw new Error(`detail returned ${res.status}`);
  }
}

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  let ok = 0;
  let failed = 0;
  const results = [];
  async function next() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        results.push(await worker(item));
        ok++;
      } catch (err) {
        failed++;
        console.warn(`  Failed "${item.url}": ${err.message}`);
      }
      if ((ok + failed) % 100 === 0) console.log(`  Progress: ${ok + failed}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, next));
  return { results, ok, failed };
}

export async function fetchCoopStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const list = await fetchStoreList();
  console.log(`[Coop] Fetching location details for ${list.length} stores (concurrency ${CONCURRENCY})...`);

  const { results, ok, failed } = await runWithConcurrency(list, CONCURRENCY, async (store) => {
    const detail = await fetchStoreDetail(store.ledgerAccountNumber);
    return {
      external_id: store.url.replace(/^\/butiker-erbjudanden\//, ""),
      name: store.name,
      url: `https://www.coop.se${store.url}`,
      address: detail.address ?? null,
      city: detail.city ?? null,
      latitude: detail.latitude ?? null,
      longitude: detail.longitude ?? null,
    };
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`[Coop] Done: ${ok} stores fetched, ${failed} failed. Output -> ${OUTPUT_FILE}`);
  return { ok, failed, total: list.length };
}

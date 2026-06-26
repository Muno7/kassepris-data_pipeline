// Step 1: FETCH (ICA stores)
//
// ICA's own store-locator page (ica.se/butiker/) server-renders a complete
// list of every store - name, address, lat/lng, and a store detail URL - into
// a window.__INITIAL_DATA__ blob, the same trick used for product offers.
// One HTTP GET gets every ICA store in the country, no browser involved.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const OUTPUT_FILE = path.join(DATA_DIR, "ica_stores.json");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function extractInitialData(html) {
  const marker = "window.__INITIAL_DATA__ = ";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let i = jsonStart;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }

  let jsonStr = html.slice(jsonStart, i);
  jsonStr = jsonStr.replace(/:undefined/g, ":null").replace(/new Map\(\[\]\)/g, "[]");
  return JSON.parse(jsonStr);
}

// bhsUrl points at the store-info page (.../butiker/<profile>/<kommun>/<slug>-<id>/);
// the offer page (.../erbjudanden/<slug>-<id>/) reuses that same final slug.
function deriveOffersUrl(bhsUrl) {
  const slug = bhsUrl.replace(/\/$/, "").split("/").pop();
  return `https://www.ica.se/erbjudanden/${slug}/`;
}

export async function fetchIcaStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const res = await fetch("https://www.ica.se/butiker/", { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`ICA store list page returned ${res.status}`);
  const html = await res.text();

  const data = extractInitialData(html);
  const slimStores = data?.SlimStores?.slimStores ?? [];

  const stores = slimStores.map((s) => ({
    external_id: s.accountNumber,
    name: s.storeName,
    url: deriveOffersUrl(s.bhsUrl),
    address: s.address?.street ?? null,
    city: s.address?.city ?? null,
    latitude: s.lat != null ? parseFloat(s.lat) : null,
    longitude: s.lng != null ? parseFloat(s.lng) : null,
  }));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(stores, null, 2));
  console.log(`[ICA] Done: ${stores.length} stores fetched in one request. Output -> ${OUTPUT_FILE}`);
  return { ok: stores.length, failed: 0, total: stores.length };
}

// Step 1: FETCH
//
// Pulls every ICA store from the DB, then for each one downloads the plain
// store offer page HTML and pulls the window.__INITIAL_DATA__ JSON blob out
// of it - ICA server-renders every offer into that blob already, so there is
// no API call to make and no browser involved, just one HTTP GET per store.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");

// ICA's edge protection (Akamai) blocks bursts of concurrent requests, so
// this chain needs to be fetched slowly.
const CONCURRENCY = 3;
const DELAY_MS = 250;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStorePathFromUrl(url) {
  const prefix = "https://www.ica.se/erbjudanden/";
  return url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/$/, "") : url;
}

// Fallback identity for offers without a gtin. Excludes gtin/validUntil/
// variantGroup too - the barcode and grouping key are stored separately, and
// validUntil changes every campaign week, which would otherwise break dedup
// across weekly runs.
function generateFingerprint(productData) {
  const { moreInfo, badges, traits, categoryName, fingerprint, image, store, gtin, validUntil, variantGroup, ...rest } =
    productData;
  return Object.values(rest)
    .map((v) => (v === null || v === undefined ? "NULL" : String(v).toUpperCase().replace(/\s/g, "")))
    .join("");
}

function parsePriceToCents(str) {
  if (!str) return null;
  const first = str.split(/[-–]/)[0].trim();
  const normalized = first.replace(",", ".").replace(/[^\d.]/g, "");
  const val = parseFloat(normalized);
  return Number.isFinite(val) ? Math.round(val * 100) : null;
}

// ICA's mechanic types vary (plain multi-buy, percentage off, "buy X pay for
// Y"). FIXED and PERCOFF resolve to an exact discounted price. BENFIXED
// ("Köp X betala för Y") is now also resolved exactly: quantity items cost
// value2 total, so the effective per-unit price is value2/quantity - rather
// than falling back to the undiscounted regular price.
function resolvePriceAndDeal(offer) {
  const regularPriceCents = parsePriceToCents(offer.stores?.[0]?.regularPrice);
  const m = offer.parsedMechanics;

  if (!m) return { priceCents: regularPriceCents, unit: null, deal: null };

  if (m.benefitType === "FIXED" && m.quantity >= 2) {
    return { priceCents: parsePriceToCents(m.value2), unit: null, deal: m.value1 || null };
  }

  if (m.benefitType === "PERCOFF") {
    const pct = parseFloat(m.value2);
    const priceCents =
      regularPriceCents != null && Number.isFinite(pct)
        ? Math.round(regularPriceCents * (1 - pct / 100))
        : regularPriceCents;
    return { priceCents, unit: null, deal: offer.details?.mechanicInfo ?? null };
  }

  if (m.benefitType === "BENFIXED" && m.quantity >= 1) {
    const totalCents = parsePriceToCents(m.value2);
    const priceCents = totalCents != null ? Math.round(totalCents / m.quantity) : regularPriceCents;
    return { priceCents, unit: null, deal: offer.details?.mechanicInfo ?? null };
  }

  if (m.quantity <= 1 && m.benefitType === "FIXED") {
    return { priceCents: regularPriceCents, unit: "/st", deal: null };
  }

  // Any other/unknown mechanic.
  return { priceCents: regularPriceCents, unit: null, deal: offer.details?.mechanicInfo ?? null };
}

// Each ean is a real, separately barcoded SKU (e.g. one specific flavor under
// a shared offer) - not a display-only variant of one product. They're
// emitted as independent product rows that share a variantGroup key, rather
// than nested inside one row's JSON.
function mapOffer(offer, storePath) {
  const details = offer.details ?? {};
  const { priceCents, unit, deal } = resolvePriceAndDeal(offer);
  const categoryName = offer.category?.articleGroupName ?? "Ospecificerat";

  const moreInfoParts = [offer.restriction, details.customerInformation, details.disclaimer, offer.condition].filter(
    Boolean
  );
  const moreInfo = moreInfoParts.join(". ") || null;

  const eans = offer.eans && offer.eans.length > 0 ? offer.eans : [null];
  const variantGroup = eans.length > 1 ? offer.id : null;

  return eans.map((ean) => {
    const productData = {
      title: ean?.articleDescription || details.name || null,
      priceCents,
      unit,
      deal,
      size: details.packageInformation ?? null,
      brand: details.brand ?? null,
      moreInfo,
      comparisonPrice: offer.comparisonPrice ?? null,
      image: ean?.image ?? null,
      isMember: offer.traits?.includes("Stammis") ?? false,
      traits: offer.traits ?? [],
      gtin: ean?.id ?? null,
      validUntil: offer.validTo ?? null,
      categoryName,
      store: storePath,
      variantGroup,
    };
    productData.fingerprint = generateFingerprint(productData);
    return productData;
  });
}

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

async function fetchOneStore(store) {
  await sleep(DELAY_MS);

  const res = await fetch(store.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`page returned ${res.status}`);
  const html = await res.text();

  const data = extractInitialData(html);
  if (!data) throw new Error("window.__INITIAL_DATA__ not found");

  const offerLists = [
    data.offers?.weeklyOffers,
    data.offers?.personalOffers,
    data.offers?.compensationOffers,
    data.offers?.offers,
  ].filter(Array.isArray);

  const seenIds = new Set();
  const storePath = extractStorePathFromUrl(store.url);
  const products = [];
  for (const list of offerLists) {
    for (const offer of list) {
      if (seenIds.has(offer.id)) continue;
      seenIds.add(offer.id);
      products.push(...mapOffer(offer, storePath));
    }
  }

  fs.writeFileSync(path.join(DATA_DIR, `${storePath}.json`), JSON.stringify(products, null, 2));
  return products.length;
}

async function runWithConcurrency(items, limit, worker) {
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
        console.warn(`  Failed "${item.url}": ${err.message}`);
      }
      if ((ok + failed) % 100 === 0) console.log(`  Progress: ${ok + failed}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, next));
  return { ok, failed };
}

export async function fetchAllIcaStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { rows: stores } = await pool.query(
    `SELECT s.url, s.name FROM stores s JOIN chain c ON s.chain_id = c.id WHERE c.slug = 'ica' AND s.url IS NOT NULL`
  );

  console.log(`[ICA] Fetching offers for ${stores.length} stores (concurrency ${CONCURRENCY}, ${DELAY_MS}ms delay)...`);
  const { ok, failed } = await runWithConcurrency(stores, CONCURRENCY, fetchOneStore);
  console.log(`[ICA] Done: ${ok} stores fetched, ${failed} failed. Raw output -> ${DATA_DIR}`);
  return { ok, failed, total: stores.length };
}

// Step 1: FETCH
//
// Pulls every Coop store from the DB, then for each one calls Coop's own
// offers API (the same JSON endpoint Coop's website calls internally) and
// writes the raw response - reshaped into the shared product field names -
// to data/{store}.json. No browser involved: this is a plain HTTP request
// per store.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.resolve(__dirname, "data");
const CONCURRENCY = 10;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Public client keys shipped in Coop's own frontend bundle - every visitor's
// browser sends these, they are not secret credentials.
const PRODUCTS_SUBSCRIPTION_KEY = "32895bd5b86e4a5ab6e94fb0bc8ae234"; // external.api.coop.se (offers)
const STORE_INFO_SUBSCRIPTION_KEY = "990520e65cc44eef89e9e9045b57f4e9"; // proxy.api.coop.se (store list)

// Coop's offers API groups products by an internal team taxonomy
// (categoryTeam.name) that doesn't match the storefront's filter-button
// category names the normalizer expects. This bridges the two.
const TEAM_TO_BUTTON_CATEGORY = {
  "Chark/Deli/Färdigmat": "Deli & chark",
  "Färskt Protein": "Fågel, fisk & kött",
  "Frukt/Grönt/Blommor": "Frukt & grönt",
  Mejeri: "Mejeri & ägg",
  Ost: "Mejeri & ägg",
  Bröd: "Bröd & bageri",
  Djupfryst: "Frysvaror",
  Kolonial: "Skafferi",
  Konfektyr: "Godis & snacks",
  "varm dryck": "Kaffe & dryck",
  "Kall Dryck": "Kaffe & dryck",
  Hemmet: "Hem & fritid",
  "Kem/Barn/Djur": "Hem & fritid",
  Barnet: "Hem & fritid",
};
const FALLBACK_BUTTON_CATEGORY = "Hem & fritid";

// Fallback identity for offers without a gtin. Excludes gtin/validUntil/
// variantGroup too - the barcode and grouping key are stored separately, and
// validUntil changes every campaign week, which would otherwise break dedup
// across weekly runs.
function generateFingerprint(productData) {
  const { badges, categoryName, store, fingerprint, image, gtin, validUntil, variantGroup, ...rest } = productData;
  return Object.values(rest)
    .map((v) => (v === null || v === undefined ? "NULL" : String(v).toUpperCase().replace(/\s/g, "")))
    .join("");
}

function mapOfferFields(offer) {
  const priceInformation = offer.priceInformation ?? {};
  const content = offer.content ?? {};

  return {
    title: content.title ?? null,
    priceCents: priceInformation.discountValue != null ? Math.round(priceInformation.discountValue * 100) : null,
    unit: priceInformation.unit ?? null,
    deal: priceInformation.dealType ?? null,
    size: content.amountInformation ?? null,
    brand: content.brand ?? null,
    max: content.dealOfferLimitText ?? null,
    comparisonPrice: content.comparativePriceText ?? null,
    image: content.imageUrl ? `https:${content.imageUrl}` : null,
    isMember: priceInformation.isMemberPrice ?? false,
    badges: [],
    gtin: offer.externalId ?? null,
    validUntil: offer.campaignEndDate ?? null,
    // Coop's API never exposes a regular/original price - priceInformation
    // only ever carries the already-discounted value.
    savingsCents: null,
  };
}

// Each clusterInteriorOffer is a real, separately barcoded SKU (e.g. a
// specific coffee roast within a "Bryggkaffe" campaign) - not a display-only
// variant of one product. They're emitted as independent product rows that
// share a variantGroup key, rather than nested inside one row's JSON. The
// top-level offer itself is just a duplicate of the cluster's first item
// (same externalId), used by Coop's frontend as the campaign-card headline,
// so it's only emitted standalone when there's no cluster to begin with.
function mapOffer(offer, storePath) {
  const categoryName = TEAM_TO_BUTTON_CATEGORY[offer.categoryTeam?.name] ?? FALLBACK_BUTTON_CATEGORY;
  const cluster = offer.clusterInteriorOffers ?? [];

  const items = cluster.length > 0 ? cluster : [offer];
  const variantGroup = cluster.length > 1 ? offer.id : null;

  return items.map((item) => {
    const productData = {
      ...mapOfferFields(item),
      categoryName,
      store: storePath,
      variantGroup,
    };
    productData.fingerprint = generateFingerprint(productData);
    return productData;
  });
}

// One bulk request gives every store's ledgerAccountNumber (the id Coop's
// offers API actually needs), keyed by store URL. Cached so all stores share
// a single bulk fetch instead of redoing it each time.
let ledgerByUrlPromise = null;

async function loadLedgerMap() {
  const res = await fetch("https://proxy.api.coop.se/external/store/stores?api-version=v5", {
    headers: { "Ocp-Apim-Subscription-Key": STORE_INFO_SUBSCRIPTION_KEY, Accept: "application/json" },
  });
  const data = await res.json();

  const map = new Map();
  for (const store of data.stores) {
    if (!store.url) continue;
    const key = store.url.replace(/^\/butiker-erbjudanden\//, "");
    map.set(key, store.ledgerAccountNumber);
  }
  return map;
}

async function getLedgerAccountNumber(storeExternalId) {
  if (!ledgerByUrlPromise) ledgerByUrlPromise = loadLedgerMap();
  const map = await ledgerByUrlPromise;
  return map.get(storeExternalId) ?? null;
}

async function fetchOneStore(store) {
  const ledgerId = await getLedgerAccountNumber(store.external_id);
  if (!ledgerId) throw new Error("no ledgerAccountNumber found");

  const res = await fetch(
    `https://external.api.coop.se/dke/offers/sorting-groups/${ledgerId}?api-version=v2&clustered=true&grouped=true`,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": PRODUCTS_SUBSCRIPTION_KEY,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    }
  );
  if (!res.ok) throw new Error(`API returned ${res.status}`);

  const data = await res.json();
  const alla = data.sortingGroups?.find((g) => g.id === "alla");
  const offers = alla?.offers ?? [];

  const products = offers.flatMap((offer) => mapOffer(offer, store.external_id));
  const filename = store.external_id.replace(/\/$/, "").replace(/\//g, "-");
  fs.writeFileSync(path.join(DATA_DIR, `${filename}.json`), JSON.stringify(products, null, 2));
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
        console.warn(`  Failed "${item.external_id}": ${err.message}`);
      }
      if ((ok + failed) % 100 === 0) console.log(`  Progress: ${ok + failed}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, next));
  return { ok, failed };
}

export async function fetchAllCoopStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { rows: stores } = await pool.query(
    `SELECT s.external_id, s.name FROM stores s JOIN chain c ON s.chain_id = c.id WHERE c.slug = 'coop' AND s.external_id IS NOT NULL`
  );

  console.log(`[Coop] Fetching offers for ${stores.length} stores (concurrency ${CONCURRENCY})...`);
  const { ok, failed } = await runWithConcurrency(stores, CONCURRENCY, fetchOneStore);
  console.log(`[Coop] Done: ${ok} stores fetched, ${failed} failed. Raw output -> ${DATA_DIR}`);
  return { ok, failed, total: stores.length };
}

import { Pool } from "pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve("../../.env") });
const DATABASE_URL = process.env.DB_URL;

if (!DATABASE_URL) {
  console.error("Error: DB_URL is undefined. Check your .env file.");
  process.exit(1);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Public client key shipped in Coop's own frontend bundle, sent by every
// visitor's browser to their Azure APIM gateway - not a secret credential.
const COOP_SUBSCRIPTION_KEY = "990520e65cc44eef89e9e9045b57f4e9";

// ICA's edge protection (Akamai) blocks bursts of concurrent requests, so this
// chain needs to be fetched slowly - low concurrency, with a small delay per request.
const ICA_CONCURRENCY = 2;
const ICA_DELAY_MS = 250;
const DEFAULT_CONCURRENCY = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ICA's store offer page server-renders address/city/lat/lng directly into
// the HTML (same page already used for product scraping), so no extra request needed.
async function fetchIcaLocation(store) {
  await sleep(ICA_DELAY_MS);
  const res = await fetch(store.url, { headers: { "User-Agent": USER_AGENT } });
  const html = await res.text();

  const address = html.match(/"visitingAddress":"([^"]*)"/)?.[1] ?? null;
  const zipCode = html.match(/"visitingZipCode":"([^"]*)"/)?.[1] ?? null;
  const city = html.match(/"visitingCity":"([^"]*)"/)?.[1] ?? null;
  const latitude = html.match(/"latitude":"([^"]*)"/)?.[1];
  const longitude = html.match(/"longitude":"([^"]*)"/)?.[1];

  if (!latitude || !longitude) return null;

  return {
    address: address && zipCode && city ? `${address}, ${zipCode} ${city}` : address,
    city,
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
  };
}

// Coop's per-store detail endpoint is keyed by a zero-padded 6-digit ledgerAccountNumber
// string (e.g. "016042"). The store page's embedded JS strips the leading zero
// (e.g. 16042), which the API silently treats as "not found" and falls back to
// returning its full unrelated store list instead of erroring - so the numeric id
// scraped from the page can't be used directly. Fetching the bulk store list once
// gives the real, correctly-padded id per store (matched by url), and also avoids
// 727 redundant page fetches entirely.
let coopLedgerByUrlPromise = null;

async function loadCoopLedgerMap() {
  const res = await fetch("https://proxy.api.coop.se/external/store/stores?api-version=v5", {
    headers: { "Ocp-Apim-Subscription-Key": COOP_SUBSCRIPTION_KEY, Accept: "application/json" },
  });
  const data = await res.json();

  const map = new Map();
  for (const store of data.stores) {
    // store.url is "/butiker-erbjudanden/coop/coop-hofors/"; external_id is "coop/coop-hofors/".
    // A handful of entries (other concepts like X:-tra) have no url at all - skip those.
    if (!store.url) continue;
    const key = store.url.replace(/^\/butiker-erbjudanden\//, "");
    map.set(key, store.ledgerAccountNumber);
  }
  return map;
}

async function fetchCoopLocation(store) {
  if (!coopLedgerByUrlPromise) {
    coopLedgerByUrlPromise = loadCoopLedgerMap();
  }
  const coopLedgerByUrl = await coopLedgerByUrlPromise;

  const ledgerId = coopLedgerByUrl.get(store.external_id);
  if (!ledgerId) return null;

  const apiRes = await fetch(
    `https://proxy.api.coop.se/external/store/stores/${ledgerId}?api-version=v5`,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": COOP_SUBSCRIPTION_KEY,
        Accept: "application/json",
      },
    }
  );
  if (!apiRes.ok) return null;

  const data = await apiRes.json();
  if (data.latitude == null || data.longitude == null) return null;

  return {
    address: data.address && data.postalCode && data.city
      ? `${data.address}, ${data.postalCode} ${data.city}`
      : data.address ?? null,
    city: data.city ?? null,
    latitude: data.latitude,
    longitude: data.longitude,
  };
}

// Willys' store-info CMS component is keyed by storeId, which is exactly the
// numeric code already stored as external_id (e.g. "2102").
async function fetchWillysLocation(store) {
  const apiRes = await fetch(
    `https://www.willys.se/axfoodcommercewebservices/v2/willys/cms/components?componentIds=WillysDefaultRightColumnStoreInfoComponent&storeId=${store.external_id}&pageSize=1`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
  );
  if (!apiRes.ok) return null;

  const data = await apiRes.json();
  const address = data.component?.[0]?.store?.address;
  if (!address || address.latitude == null || address.longitude == null) return null;

  return {
    address: address.formattedAddress ?? null,
    city: address.town ?? null,
    latitude: parseFloat(address.latitude),
    longitude: parseFloat(address.longitude),
  };
}

const FETCHERS = {
  ica: fetchIcaLocation,
  coop: fetchCoopLocation,
  willys: fetchWillysLocation,
};

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  let succeeded = 0;
  let failed = 0;

  async function next() {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      try {
        await worker(item);
        succeeded++;
      } catch (err) {
        failed++;
        console.warn(`Failed to enrich "${item.name}" (${item.external_id}):`, err.message);
      }
      if ((succeeded + failed) % 50 === 0) {
        console.log(`Progress: ${succeeded + failed}/${items.length} (${failed} failed)`);
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, next));
  return { succeeded, failed };
}

async function enrichLocations() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const { rows: chains } = await client.query("SELECT id, slug FROM chain");

    for (const chain of chains) {
      const fetchLocation = FETCHERS[chain.slug];
      if (!fetchLocation) {
        console.warn(`No location fetcher for chain "${chain.slug}", skipping.`);
        continue;
      }

      const { rows: stores } = await client.query(
        "SELECT id, external_id, name, url FROM stores WHERE chain_id = $1 AND latitude IS NULL",
        [chain.id]
      );

      console.log(`\n=== ${chain.slug}: ${stores.length} stores missing location ===`);

      const concurrency = chain.slug === "ica" ? ICA_CONCURRENCY : DEFAULT_CONCURRENCY;

      const { succeeded, failed } = await runWithConcurrency(stores, concurrency, async (store) => {
        const location = await fetchLocation(store);
        if (!location) {
          throw new Error("no location data returned");
        }
        await client.query(
          `UPDATE stores SET address = $1, city = $2, latitude = $3, longitude = $4, updated_at = now()
           WHERE id = $5`,
          [location.address, location.city, location.latitude, location.longitude, store.id]
        );
      });

      console.log(`${chain.slug}: ${succeeded} updated, ${failed} failed`);
    }

    console.log("\nLocation enrichment completed.");
  } finally {
    client.release();
    await pool.end();
  }
}

enrichLocations();

// Willys-only now: Coop/ICA already get address/city/lat/lng directly in
// their own stores/coop/fetch.js and stores/ica/fetch.js (each store's bulk
// list or detail call already returns coordinates), so this old shared
// script's Coop/ICA fetchers became dead code once those existed - removed.
// stores/scripts/import_stores.js only sets name/url/external_id/
// assortment_id for Willys, so this is still the only thing populating its
// coordinates.

import { pool } from "../../db/pool.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CONCURRENCY = 8;

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

async function enrichWillysLocations() {
  try {
    const { rows: chainRows } = await pool.query("SELECT id FROM chains WHERE slug = 'willys'");
    if (chainRows.length === 0) {
      console.warn(`Chain "willys" not found - run db/schema.sql first.`);
      return;
    }
    const chainId = chainRows[0].id;

    const { rows: stores } = await pool.query(
      "SELECT id, external_id, name, url FROM stores WHERE chain_id = $1 AND latitude IS NULL",
      [chainId]
    );

    console.log(`Willys: ${stores.length} stores missing location`);

    // Each worker grabs its own connection per query (pool.query, not a
    // single shared client) - CONCURRENCY workers genuinely run in parallel
    // instead of queuing on one connection.
    const { succeeded, failed } = await runWithConcurrency(stores, CONCURRENCY, async (store) => {
      const location = await fetchWillysLocation(store);
      if (!location) throw new Error("no location data returned");
      await pool.query(
        `UPDATE stores SET address = $1, city = $2, latitude = $3, longitude = $4, updated_at = now()
         WHERE id = $5`,
        [location.address, location.city, location.latitude, location.longitude, store.id]
      );
    });

    console.log(`Willys: ${succeeded} updated, ${failed} failed`);
  } finally {
    await pool.end();
  }
}

enrichWillysLocations();

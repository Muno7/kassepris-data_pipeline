// Step 1: FETCH
//
// Pulls every Coop store from the DB, then for each one calls Coop's own
// offers API (the same JSON endpoint Coop's website calls internally) and
// writes the raw response - reshaped into the shared product field names -
// to data/{store}.json. No browser involved: this is a plain HTTP request
// per store.
//
// Production-ingestion concerns (retries, backoff, rate limiting, caching,
// checkpointing, schema drift detection, metrics) live in products/lib/ and
// are shared infrastructure, not Coop-specific - this file only describes
// what to fetch and how to map it.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../db/pool.js";
import { createLogger } from "../lib/logger.js";
import { createMetrics } from "../lib/metrics.js";
import { createHttpClient } from "../lib/httpClient.js";
import { createCheckpoint } from "../lib/checkpoint.js";
import { createSchemaCheck } from "../lib/schemaCheck.js";
import { requireEnv, getEnvInt, DEFAULT_USER_AGENT } from "../lib/config.js";
import { runWithRetries } from "../lib/concurrency.js";
import { buildFingerprint } from "../lib/fingerprint.js";
import { parseComparisonPrice, deriveComparisonFromDealQuantity } from "../lib/comparisonPrice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.resolve(__dirname, "data");
const STATE_DIR = path.resolve(__dirname, ".state");
// Left tunable per-environment rather than hardcoded, since the right value
// depends on what Coop's infrastructure tolerates today, not on this code.
const CONCURRENCY = getEnvInt("COOP_FETCH_CONCURRENCY", 10);
const MAX_RETRIES = getEnvInt("COOP_FETCH_MAX_RETRIES", 4);
// Extra whole-store retry passes after the first, for stores that still failed
// once httpClient's per-request retries were exhausted (see runWithRetries).
const STORE_RETRY_PASSES = getEnvInt("COOP_FETCH_STORE_RETRY_PASSES", 2);

// Public client keys shipped in Coop's own frontend bundle - every visitor's
// browser sends these, they are not secret credentials. Externalized to .env
// for config hygiene (easy to rotate/override without a code change), not
// because they need to be hidden.
const PRODUCTS_SUBSCRIPTION_KEY = requireEnv("COOP_PRODUCTS_SUBSCRIPTION_KEY"); // external.api.coop.se (offers)
const STORE_INFO_SUBSCRIPTION_KEY = requireEnv("COOP_STORE_INFO_SUBSCRIPTION_KEY"); // proxy.api.coop.se (store list)

// One set of shared collaborators for this whole run - a single client/
// logger/metrics instance so retry counts, cache hits, etc. accumulate
// across every store instead of resetting per request.
const logger = createLogger("coop:fetch");
const metrics = createMetrics("coop-fetch");
const httpClient = createHttpClient({
  name: "coop-fetch",
  logger,
  metrics,
  cacheDir: path.join(STATE_DIR, "cache"),
  maxRetries: MAX_RETRIES,
  // Coop declares no rate limit (no robots Crawl-delay, no RateLimit headers),
  // so this stays 0 in every environment. Env-overridable only if that changes.
  minDelayMs: getEnvInt("COOP_FETCH_MIN_DELAY_MS", 0),
});
const checkpoint = createCheckpoint(path.join(STATE_DIR, "checkpoint.json"));
const offersSchemaCheck = createSchemaCheck(path.join(STATE_DIR, "schema-baseline-offers.json"));
const storeListSchemaCheck = createSchemaCheck(path.join(STATE_DIR, "schema-baseline-stores.json"));

// Bridges Coop's internal team taxonomy (categoryTeam.name, meant for their
// own warehouse/merchandising org) to the storefront's customer-facing
// category names, which is what the normalizer expects to map onto our
// shared display categories.
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

// Gives every offer without a gtin a stable identity to upsert/dedupe on
// anyway. Excludes fields that can change without the underlying product
// changing - store/categoryName (view-dependent, not product-dependent),
// validUntil/max (roll over every campaign week), image/badges (cosmetic) -
// so the same physical product still matches itself week over week.
//
// Also excludes every price/deal field (priceCents, unit, deal,
// comparisonPrice*, isMember, savingsCents) for the same reason: a weekly
// price or promo change is the normal case for a deals feed, not evidence
// of a different product. Confirmed empirically (see Willys, which shares
// this same rule) that leaving price fields in produces a *different*
// fingerprint - and therefore a duplicate, unlinked product row - every
// time a price changes, which defeats both dedup and any price-history
// table keyed on product_id. What's left (title, brand, size) is
// deliberately thin - it only needs to answer "is this the same physical
// item", not describe it.
function generateFingerprint(productData) {
  const {
    badges,
    categoryName,
    store,
    fingerprint,
    image,
    gtin,
    validFrom,
    validUntil,
    variantGroup,
    max,
    priceCents,
    unit,
    deal,
    dealQuantity,
    comparisonPrice,
    comparisonPriceMinCents,
    comparisonPriceMaxCents,
    comparisonUnit,
    isMember,
    savingsCents,
    ...rest
  } = productData;
  return buildFingerprint(rest);
}

// Reshapes one raw Coop offer into the field names every chain's normalizer
// expects, so nothing downstream ever needs to know which chain a product
// came from.
function mapOfferFields(offer) {
  const priceInformation = offer.priceInformation ?? {};
  const content = offer.content ?? {};
  const splash = offer.unifiedSplash ?? {};
  const comparisonPriceText = content.comparativePriceText ?? null;
  const comparison = parseComparisonPrice(comparisonPriceText);
  const priceCents = priceInformation.discountValue != null ? Math.round(priceInformation.discountValue * 100) : null;
  const dealQuantity = priceInformation.minimumAmount ?? null;
  // Falls back to price_cents / dealQuantity only when Coop's own
  // comparativePriceText didn't parse - see
  // deriveComparisonFromDealQuantity for why this is a weaker (per-st, not
  // per-kg/per-l) but still real, directly-comparable number, never a
  // substitute for the provider's own figure when that's available.
  const fallbackComparison = !comparison ? deriveComparisonFromDealQuantity(priceCents, dealQuantity) : null;

  return {
    title: content.title ?? null,
    // For a real multi-buy ("3 för 25:-"), discountValue is the *bundle*
    // total (25), not a per-item price - confirmed against Coop's own raw
    // API response (priceInformation.minimumAmount + unifiedSplash both
    // agree on the same N, e.g. "3 för"/minimumAmount:3 together on one
    // offer). dealType stays "pris"/"styckpris" regardless (it only ever
    // means "unit price", not "this is a single item"), so it's not a
    // usable signal here - unifiedSplash.prefix is the real one, and it's
    // formatted exactly like ICA's deal text ("2 för", "3 för", ...).
    // Deliberately left un-divided: price_cents is meant to be exactly the
    // price of the deal as Coop states it (you can't actually buy one item
    // for a third of it), not a synthetic per-item number - see
    // comparisonPriceCents below for the normalized figure instead.
    priceCents,
    unit: priceInformation.unit ?? null,
    deal: splash.prefix ?? priceInformation.dealType ?? null,
    dealQuantity,
    size: content.amountInformation ?? null,
    brand: content.brand ?? null,
    max: content.dealOfferLimitText ?? null,
    comparisonPrice: comparisonPriceText,
    comparisonPriceMinCents: comparison?.minCents ?? fallbackComparison?.minCents ?? null,
    comparisonPriceMaxCents: comparison?.maxCents ?? fallbackComparison?.maxCents ?? null,
    comparisonUnit: comparison?.unit ?? fallbackComparison?.unit ?? null,
    image: content.imageUrl ? `https:${content.imageUrl}` : null,
    isMember: priceInformation.isMemberPrice ?? false,
    badges: [],
    gtin: offer.externalId ?? null,
    validFrom: offer.campaignStartDate ?? null,
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

// Fails loudly if Coop ever changes this endpoint's shape, instead of
// silently building an empty/broken ledger map that every store lookup
// downstream would then fail against one at a time.
function validateStoreListResponse(data) {
  if (!Array.isArray(data?.stores)) throw new Error("store list response missing/invalid `stores` array");
}

// Confirmed empirically: stores with nothing on offer this week return a
// bare `{}` (200 OK, no sortingGroups key at all) rather than an empty
// array - a legitimate "zero offers" state, not a broken response, and a
// stable one for certain store formats (mini/café stores), so treating it
// as a validation failure would flag the same stores as "failed" on every
// single run forever. Only a `sortingGroups` that's present but not an
// array is an actual schema violation worth failing on.
function validateOffersResponse(data) {
  if (data.sortingGroups !== undefined && !Array.isArray(data.sortingGroups)) {
    throw new Error("offers response has non-array `sortingGroups`");
  }
}

// One bulk request gives every store's ledgerAccountNumber (the id Coop's
// offers API actually needs), keyed by store URL. Cached so all stores share
// a single bulk fetch instead of redoing it each time.
let ledgerByUrlPromise = null;

async function loadLedgerMap() {
  const { data } = await httpClient.fetchJson("https://proxy.api.coop.se/external/store/stores?api-version=v5", {
    headers: { "Ocp-Apim-Subscription-Key": STORE_INFO_SUBSCRIPTION_KEY, Accept: "application/json" },
  });
  validateStoreListResponse(data);

  const schemaResult = storeListSchemaCheck.check(data);
  if (schemaResult.changed) {
    metrics.recordSchemaChange(`store-list: +[${schemaResult.added.join(",")}] -[${schemaResult.removed.join(",")}]`);
    logger.warn("store list API schema changed since last run", schemaResult);
  }

  const map = new Map();
  for (const store of data.stores) {
    if (!store.url) continue;
    const key = store.url.replace(/^\/butiker-erbjudanden\//, "");
    map.set(key, store.ledgerAccountNumber);
  }
  return map;
}

// Looks up one store's ledger id against the shared bulk map, triggering
// that bulk fetch at most once no matter how many stores ask concurrently.
async function getLedgerAccountNumber(storeExternalId) {
  if (!ledgerByUrlPromise) ledgerByUrlPromise = loadLedgerMap();
  const map = await ledgerByUrlPromise;
  return map.get(storeExternalId) ?? null;
}

// Built up across every store fetched this run rather than checked once -
// see products/lib/schemaCheck.js for why sampling just one store's
// response produces false positives on Coop's sparse/optional fields.
const offersSchemaAccumulator = offersSchemaCheck.createAccumulator();

// Fetches, validates, and writes one store's offers - the single unit of
// work that concurrency, retries, and checkpointing all operate on.
async function fetchOneStore(store) {
  if (checkpoint.isDone(store.external_id)) {
    logger.debug("skipping, already completed (resumed run)", { store: store.external_id });
    return;
  }

  const ledgerId = await getLedgerAccountNumber(store.external_id);
  if (!ledgerId) throw new Error("no ledgerAccountNumber found");

  const { data } = await httpClient.fetchJson(
    `https://external.api.coop.se/dke/offers/sorting-groups/${ledgerId}?api-version=v2&clustered=true&grouped=true`,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": PRODUCTS_SUBSCRIPTION_KEY,
        Accept: "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
      },
    }
  );

  try {
    validateOffersResponse(data);
  } catch (err) {
    metrics.recordValidationFailure();
    throw err;
  }

  offersSchemaAccumulator.accumulate(data);

  const alla = data.sortingGroups?.find((g) => g.id === "alla");
  const offers = alla?.offers ?? [];

  const products = offers.flatMap((offer) => mapOffer(offer, store.external_id));
  const filename = store.external_id.replace(/\/$/, "").replace(/\//g, "-");
  fs.writeFileSync(path.join(DATA_DIR, `${filename}.json`), JSON.stringify(products, null, 2));

  // Only mark done once the file is actually written, so a crash between
  // fetch and write doesn't skip re-fetching this store on resume.
  checkpoint.markDone(store.external_id);
  return products.length;
}

// Entry point: fetches every Coop store's offers in one run and prints a
// full ingestion report at the end regardless of partial failures, so a
// scheduled run's health is visible from its own output, not just inferred
// from silence.
export async function fetchAllCoopStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { rows: stores } = await pool.query(
    `SELECT s.external_id, s.name FROM stores s JOIN chains c ON s.chain_id = c.id WHERE c.slug = 'coop' AND s.external_id IS NOT NULL`
  );

  if (checkpoint.resumedCount > 0) {
    logger.info("resuming interrupted run", { alreadyDone: checkpoint.resumedCount, total: stores.length });
  }

  logger.info("fetching offers", { stores: stores.length, concurrency: CONCURRENCY });
  const { ok, failed, failedItems } = await runWithRetries(stores, CONCURRENCY, fetchOneStore, {
    maxRetryPasses: STORE_RETRY_PASSES,
    onFailure: (store, err, pass) =>
      logger.error("store fetch failed", { store: store.external_id, pass, error: err.message }),
    onProgress: (done, total) => logger.info("progress", { done, total }),
    onRetryPass: (pass, retrying) => logger.warn("retrying failed stores", { pass, retrying }),
  });
  if (failed > 0) {
    logger.error("stores still failing after all retry passes", {
      failed,
      stores: failedItems.map((s) => s.external_id),
    });
  }
  logger.info("done", { ok, failed, total: stores.length, dataDir: DATA_DIR });

  const schemaResult = offersSchemaAccumulator.finish();
  if (schemaResult.changed) {
    metrics.recordSchemaChange(`offers: +[${schemaResult.added.join(",")}] -[${schemaResult.removed.join(",")}]`);
    logger.warn("offers API schema changed since last run", schemaResult);
  }

  // Reaching here means the run completed (didn't crash): every store was
  // attempted and any failures already exhausted their retry passes and are
  // logged above. Clear the checkpoint unconditionally so the next scheduled
  // run starts fresh. The checkpoint exists only to resume a *crashed* run
  // mid-way - NOT to permanently skip stores that merely failed. (Keeping it
  // on failure meant one dead 404 store pinned the checkpoint forever, so
  // every later run "resumed" and skipped re-fetching all the good stores,
  // staling out the whole chain.)
  checkpoint.clear();

  metrics.report();
  return { ok, failed, total: stores.length };
}

// Only runs automatically when invoked directly - products/run.js imports
// fetchAllCoopStores() instead, to orchestrate Coop and ICA in one process.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await fetchAllCoopStores();
  await pool.end();
}

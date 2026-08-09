// Step 1: FETCH
//
// Pulls every ICA store from the DB, then for each one downloads the plain
// store offer page HTML and pulls the window.__INITIAL_DATA__ JSON blob out
// of it - ICA server-renders every offer into that blob already, so there is
// no API call to make and no browser involved, just one HTTP GET per store.
//
// Production-ingestion concerns (retries, backoff, rate limiting, caching,
// checkpointing, schema drift detection, metrics) live in products/lib/ and
// are shared infrastructure, not ICA-specific - this file only describes
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
import { getEnvInt, DEFAULT_USER_AGENT } from "../lib/config.js";
import { runWithRetries } from "../lib/concurrency.js";
import { buildFingerprint } from "../lib/fingerprint.js";
import { parsePriceToCents } from "../lib/priceParsing.js";
import { parseComparisonPrice, deriveComparisonFromDealQuantity } from "../lib/comparisonPrice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");
const STATE_DIR = path.resolve(__dirname, ".state");

// Left tunable per-environment: ICA's edge protection (Akamai) blocks bursts
// of concurrent requests, so this chain needs a lower concurrency ceiling
// than Coop/Willys tolerate.
const CONCURRENCY = getEnvInt("ICA_FETCH_CONCURRENCY", 3);
const MAX_RETRIES = getEnvInt("ICA_FETCH_MAX_RETRIES", 4);
// Extra whole-store retry passes after the first, for stores that still failed
// once httpClient's per-request retries were exhausted (see runWithRetries).
const STORE_RETRY_PASSES = getEnvInt("ICA_FETCH_STORE_RETRY_PASSES", 2);

// ICA publishes its real budget on every response: `ratelimit-policy:
// 72;w=60` - 72 requests per 60-second window, confirmed directly against
// live responses, not a guess. 60000/72 ≈ 833ms is the fastest sustainable
// pace within that budget; minDelayMs (below, on the httpClient) starts a
// few ms above it (rounded up, plus a small margin for clock/timing jitter
// across concurrent workers) so the run paces itself correctly from request
// one instead of starting too fast, getting throttled, and crawling back
// via onSuccess's slow (stepDownMs) recovery - confirmed empirically that
// starting from a too-fast default (100ms) cost about 8 of the run's ~26
// minutes to that discover-then-recover cycle, well above the ~18-minute
// floor 72;w=60 actually implies for 1287 stores. onRateLimitInfo (see
// products/lib/httpClient.js) still adapts live off the real headers on top
// of this, so a future change to ICA's published policy is still handled
// automatically - this just corrects the starting assumption.

// One set of shared collaborators for this whole run - a single client/
// logger/metrics instance so retry counts, cache hits, etc. accumulate
// across every store instead of resetting per request. cacheDir is omitted:
// ICA's pages are served `Cache-Control: no-store` (confirmed empirically),
// so a local response cache would never get a usable hit here - the offers
// genuinely change from one fetch to the next, unlike Coop's 15-minute-fresh
// campaign data.
const logger = createLogger("ica:fetch");
const metrics = createMetrics("ica-fetch");
const httpClient = createHttpClient({
  name: "ica-fetch",
  logger,
  metrics,
  maxRetries: MAX_RETRIES,
  // ICA declares 72 req/60s via its RateLimit-* response headers, which the
  // httpClient gate paces to dynamically. 850ms (= 60000/72) is the static
  // floor at exactly that declared rate - and a hard one: faster gets the IP
  // 403-blocked, so it holds in test too. See config/env.js and .env.example.
  minDelayMs: getEnvInt("ICA_FETCH_MIN_DELAY_MS", 850),
});
const checkpoint = createCheckpoint(path.join(STATE_DIR, "checkpoint.json"));
const offersSchemaCheck = createSchemaCheck(path.join(STATE_DIR, "schema-baseline-offers.json"));

// Store pages are addressed by their URL slug elsewhere in the pipeline
// (normalize.js, update_db.js), not ICA's internal store id - this recovers
// that slug from the URL we already have on hand instead of a second lookup.
function extractStorePathFromUrl(url) {
  const prefix = "https://www.ica.se/erbjudanden/";
  return url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/$/, "") : url;
}

// Gives every offer without a gtin a stable identity to upsert/dedupe on
// anyway. Excludes fields that can change without the underlying product
// changing - store/categoryName (view-dependent), validUntil (rolls over
// every campaign week), image/badges/traits (cosmetic) - so the same
// physical product still matches itself week over week.
//
// Also excludes every price/deal field (priceCents, savingsCents, unit,
// deal, comparisonPrice*, isMember) for the same reason: a weekly price or
// promo change is the normal case for a deals feed, not evidence of a
// different product - see products/coop/fetch.js's generateFingerprint for
// the full reasoning (confirmed empirically on Willys: leaving price in
// produced a different fingerprint, and therefore a duplicate product row,
// on 56% of products that priced differently between its two assortments).
function generateFingerprint(productData) {
  const {
    moreInfo,
    badges,
    traits,
    categoryName,
    fingerprint,
    image,
    store,
    gtin,
    validFrom,
    validUntil,
    variantGroup,
    priceCents,
    savingsCents,
    unit,
    deal,
    comparisonPrice,
    comparisonPriceMinCents,
    comparisonPriceMaxCents,
    comparisonUnit,
    isMember,
    ...rest
  } = productData;
  return buildFingerprint(rest);
}

// ICA's mechanic types vary (plain multi-buy, percentage off, "buy X pay for
// Y"). priceCents is always the actual price of the deal as ICA states it -
// for a multi-buy that's the *bundle* total ("2 för 75" -> 75, not 37,50),
// never divided down on our own (see mapOffer's comparison-price fallback
// for where the per-item figure belongs instead - you can't actually buy
// one item for half the deal, so priceCents shouldn't claim you can).
//
// savingsCents compares that bundle total against what dealQuantity items
// would have cost at the regular per-item price - not just regularPriceCents
// itself - since the two need to describe the same basket to be comparable.
// null whenever there's nothing to compare against (no regularPrice) or the
// "deal" isn't actually cheaper (e.g. rounding, or a mismatched range - see
// parsePriceToCents' first-of-range behavior).
function withSavings(priceCents, regularPriceCents, dealQuantity = 1) {
  const regularTotalCents = regularPriceCents != null ? regularPriceCents * dealQuantity : null;
  const savingsCents =
    regularTotalCents != null && priceCents != null && regularTotalCents > priceCents
      ? regularTotalCents - priceCents
      : null;
  return { priceCents, savingsCents };
}

function resolvePriceAndDeal(offer) {
  const regularPriceCents = parsePriceToCents(offer.stores?.[0]?.regularPrice);
  const m = offer.parsedMechanics;

  if (!m) return { ...withSavings(regularPriceCents, regularPriceCents), unit: null, deal: null, dealQuantity: null };

  if (m.benefitType === "FIXED" && m.quantity >= 2) {
    // value2 is the total for `quantity` items (e.g. "2 för 75" -> value2
    // "75" means 75kr for 2, not 75kr each) - kept as that raw bundle total.
    const priceCents = parsePriceToCents(m.value2) ?? regularPriceCents;
    return {
      ...withSavings(priceCents, regularPriceCents, m.quantity),
      unit: null,
      deal: m.value1 || null,
      dealQuantity: m.quantity,
    };
  }

  if (m.benefitType === "PERCOFF") {
    const pct = parseFloat(m.value2);
    const priceCents =
      regularPriceCents != null && Number.isFinite(pct)
        ? Math.round(regularPriceCents * (1 - pct / 100))
        : regularPriceCents;
    return {
      ...withSavings(priceCents, regularPriceCents),
      unit: null,
      deal: offer.details?.mechanicInfo ?? null,
      dealQuantity: null,
    };
  }

  if (m.benefitType === "BENFIXED" && m.quantity >= 1) {
    // value2 is literally the word "betala" ("pay") for this mechanic, not a
    // price - confirmed empirically, so parsePriceToCents(m.value2) was
    // always null and this branch was silently falling back to
    // regularPriceCents, i.e. never actually applying the discount. The
    // "pay for N" count lives in value3 instead (e.g. "Köp 3 betala för 2":
    // quantity=3, value3="för 2") - the actual total for all m.quantity
    // items is regularPrice * payForQuantity (pay full price for
    // payForQuantity of them, the rest are free); there's no raw bundle
    // price text to read here the way FIXED has, so this multiplication
    // *is* the real transaction total, not a per-item approximation of it.
    const payForQuantity = parseInt(m.value3?.match(/(\d+)/)?.[1], 10);
    const priceCents =
      regularPriceCents != null && Number.isFinite(payForQuantity)
        ? regularPriceCents * payForQuantity
        : regularPriceCents;
    return {
      ...withSavings(priceCents, regularPriceCents, m.quantity),
      unit: null,
      deal: offer.details?.mechanicInfo ?? null,
      dealQuantity: m.quantity > 1 ? m.quantity : null,
    };
  }

  if (m.quantity <= 1 && m.benefitType === "FIXED") {
    return { ...withSavings(regularPriceCents, regularPriceCents), unit: "/st", deal: null, dealQuantity: null };
  }

  // Any other/unknown mechanic.
  return {
    ...withSavings(regularPriceCents, regularPriceCents),
    unit: null,
    deal: offer.details?.mechanicInfo ?? null,
    dealQuantity: null,
  };
}

// Each ean is a real, separately barcoded SKU (e.g. one specific flavor under
// a shared offer) - not a display-only variant of one product. They're
// emitted as independent product rows that share a variantGroup key, rather
// than nested inside one row's JSON.
function mapOffer(offer, storePath) {
  const details = offer.details ?? {};
  const { priceCents, savingsCents, unit, deal, dealQuantity } = resolvePriceAndDeal(offer);
  const categoryName = offer.category?.articleGroupName ?? "Ospecificerat";

  const moreInfoParts = [offer.restriction, details.customerInformation, details.disclaimer, offer.condition].filter(
    Boolean
  );
  const moreInfo = moreInfoParts.join(". ") || null;

  const eans = offer.eans && offer.eans.length > 0 ? offer.eans : [null];
  const variantGroup = eans.length > 1 ? offer.id : null;

  const comparisonPriceText = offer.comparisonPrice ?? null;
  const comparison = parseComparisonPrice(comparisonPriceText);
  // Falls back to priceCents / dealQuantity only when ICA's own
  // comparisonPrice didn't parse - see deriveComparisonFromDealQuantity for
  // why this is a weaker (per-st, not per-kg/per-l) but still real,
  // directly-comparable number, never a substitute for ICA's own figure
  // when that's available.
  const fallbackComparison = !comparison ? deriveComparisonFromDealQuantity(priceCents, dealQuantity) : null;

  return eans.map((ean) => {
    const productData = {
      title: ean?.articleDescription || details.name || null,
      priceCents,
      savingsCents,
      unit,
      deal,
      dealQuantity,
      size: details.packageInformation ?? null,
      brand: details.brand ?? null,
      moreInfo,
      comparisonPrice: comparisonPriceText,
      comparisonPriceMinCents: comparison?.minCents ?? fallbackComparison?.minCents ?? null,
      comparisonPriceMaxCents: comparison?.maxCents ?? fallbackComparison?.maxCents ?? null,
      comparisonUnit: comparison?.unit ?? fallbackComparison?.unit ?? null,
      image: ean?.image ?? null,
      isMember: offer.traits?.includes("Stammis") ?? false,
      traits: offer.traits ?? [],
      gtin: ean?.id ?? null,
      validFrom: offer.validFrom ?? null,
      validUntil: offer.validTo ?? null,
      categoryName,
      store: storePath,
      variantGroup,
    };
    productData.fingerprint = generateFingerprint(productData);
    return productData;
  });
}

// Pulls the page's embedded state out of its `<script>` tag by brace-
// matching rather than a regex, since the blob contains nested objects and
// string values that could themselves contain "}" - a naive regex would
// truncate early. Kept ICA-specific rather than moved to products/lib/,
// since no other chain currently serves data this way; worth promoting to
// shared code if a second chain ever does.
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

// Fails loudly if ICA ever stops embedding the state blob the way this
// scraper expects (a redesign, an A/B test, a bot-detection page swapped in
// for our request), instead of silently writing an empty offers file that
// would just look like "this store has no deals this week" downstream.
function validateExtractedData(data) {
  if (!data || typeof data !== "object") throw new Error("window.__INITIAL_DATA__ not found or unparsable");
  if (data.offers !== undefined && typeof data.offers !== "object") {
    throw new Error("page data has unexpected `offers` shape");
  }
}

// Accumulated across every store fetched this run rather than checked once -
// see products/lib/schemaCheck.js for why sampling a single response can
// produce false positives on sparse/optional fields. Scoped to just the
// offers substructure, not ICA's whole page-state blob (navigation, footer,
// unrelated widgets) - fingerprinting the entire blob would bury real drift
// in noise from page chrome nobody here depends on.
const offersSchemaAccumulator = offersSchemaCheck.createAccumulator();

// Fetches, validates, and writes one store's offers - the single unit of
// work that concurrency, retries, and checkpointing all operate on.
async function fetchOneStore(store) {
  if (checkpoint.isDone(store.url)) {
    logger.debug("skipping, already completed (resumed run)", { store: store.url });
    return;
  }

  const { text: html } = await httpClient.fetchText(store.url, { headers: { "User-Agent": DEFAULT_USER_AGENT } });
  const data = extractInitialData(html);

  try {
    validateExtractedData(data);
  } catch (err) {
    metrics.recordValidationFailure();
    throw err;
  }

  if (data.offers) offersSchemaAccumulator.accumulate(data.offers);

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

  // Only mark done once the file is actually written, so a crash between
  // fetch and write doesn't skip re-fetching this store on resume.
  checkpoint.markDone(store.url);
  return products.length;
}

// Entry point: fetches every ICA store's offers in one run and prints a
// full ingestion report at the end regardless of partial failures, so a
// scheduled run's health is visible from its own output, not just inferred
// from silence.
export async function fetchAllIcaStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { rows: stores } = await pool.query(
    `SELECT s.url, s.name FROM stores s JOIN chains c ON s.chain_id = c.id WHERE c.slug = 'ica' AND s.url IS NOT NULL`
  );

  if (checkpoint.resumedCount > 0) {
    logger.info("resuming interrupted run", { alreadyDone: checkpoint.resumedCount, total: stores.length });
  }

  logger.info("fetching offers", { stores: stores.length, concurrency: CONCURRENCY });
  const { ok, failed, failedItems } = await runWithRetries(stores, CONCURRENCY, fetchOneStore, {
    maxRetryPasses: STORE_RETRY_PASSES,
    onFailure: (store, err, pass) => logger.error("store fetch failed", { store: store.url, pass, error: err.message }),
    onProgress: (done, total) => logger.info("progress", { done, total }),
    onRetryPass: (pass, retrying) => logger.warn("retrying failed stores", { pass, retrying }),
  });
  if (failed > 0) {
    logger.error("stores still failing after all retry passes", {
      failed,
      stores: failedItems.map((s) => s.url),
    });
  }
  logger.info("done", { ok, failed, total: stores.length, dataDir: DATA_DIR });

  const schemaResult = offersSchemaAccumulator.finish();
  if (schemaResult.changed) {
    metrics.recordSchemaChange(`offers: +[${schemaResult.added.join(",")}] -[${schemaResult.removed.join(",")}]`);
    logger.warn("offers page schema changed since last run", schemaResult);
  }

  // Reaching here means the run completed (didn't crash): every store was
  // attempted and any failures already exhausted their retry passes and are
  // logged above. Clear the checkpoint unconditionally so the next scheduled
  // run starts fresh. The checkpoint exists only to resume a *crashed* run
  // mid-way - NOT to permanently skip stores that merely failed. (ICA has a
  // handful of dead 404 stores; keeping the checkpoint on failure pinned it
  // forever, so every later run "resumed" and skipped re-fetching all the
  // good stores, staling out the whole chain.)
  checkpoint.clear();

  metrics.report();
  return { ok, failed, total: stores.length };
}

// Only runs automatically when invoked directly - products/run.js imports
// fetchAllIcaStores() instead, to orchestrate Coop and ICA in one process.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await fetchAllIcaStores();
  await pool.end();
}

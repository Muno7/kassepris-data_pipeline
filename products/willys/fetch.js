// Step 1: FETCH
//
// Willys's offers page is a Next.js storefront, but the actual data comes
// from a plain JSON endpoint: GET /axfood/rest/v1/search/campaigns/offline,
// called with no cookies, no session, and no CSRF token - confirmed via a
// captured browser network trace plus repeated plain `curl` calls. (The
// previous version of this file claimed that endpoint was bot-protected -
// that turned out to be wrong: it's just unauthenticated, store offers are
// requested via the `q` query param, e.g. q=2102:categoryLevel1_string_mv:N16
// for store "2102" filtered to category "N16". The Solr-style filter after
// the colon is required to get a categoryName per product - the bare
// `q=<storeCode>` response carries no category field on individual products,
// only as a facet count summary - so this fetches once per category instead
// of once per store, matching the Puppeteer scraper's old per-category-click
// loop.)
//
// Like the old scraper, this only ever fetches two representative stores -
// one per real assortment ("willys" and "willys-hemma") - since Willys
// (unlike Coop/ICA) groups every store's offers into one of those two shared
// newspaper assortments. Confirmed empirically: every regular Willys store
// returns the exact same totalNumberOfResults as every other regular store,
// and a different (smaller) total for every Hemma store.
//
// Production-ingestion concerns (retries, backoff, rate limiting, caching,
// checkpointing, schema drift detection, metrics) live in products/lib/ and
// are shared infrastructure, not Willys-specific - this file only describes
// what to fetch and how to map it.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dataDir, stateDir } from "../lib/paths.js";
import { createLogger } from "../lib/logger.js";
import { createMetrics } from "../lib/metrics.js";
import { createHttpClient } from "../lib/httpClient.js";
import { createCheckpoint } from "../lib/checkpoint.js";
import { createSchemaCheck } from "../lib/schemaCheck.js";
import { getEnvInt, DEFAULT_USER_AGENT } from "../lib/config.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import { parsePriceToCents } from "../lib/priceParsing.js";
import { parseComparisonPrice, deriveComparisonFromDealQuantity } from "../lib/comparisonPrice.js";
import { isValidGtin13 } from "../lib/gtin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = dataDir("willys");
const STATE_DIR = stateDir("willys");
const STORES_FILE = path.resolve(__dirname, "../../stores/willys/willys_stores.json");

const BASE_URL = "https://www.willys.se/axfood/rest/v1/search/campaigns/offline";
const SITE_ORIGIN = "https://www.willys.se";
const PAGE_SIZE = 100;

// The plain full-catalog search endpoint (the one that powers willys.se/sok),
// separate from the campaigns/offline endpoint above. Used only as a GTIN
// fallback: a handful of campaign products per run carry a promo-only image
// with no GTIN in it, but the same product exists in the regular catalog under
// the same internal `code` (== the campaign's mainProductCode) with a
// GTIN-bearing catalog photo. See products/willys/GTIN_FALLBACK_PLAN.md.
const SEARCH_URL = "https://www.willys.se/axfood/rest/v1/search";
// Kept below CONCURRENCY: this backs /sok, which robots.txt marks
// crawl-sensitive, and it's only ever a small per-run cleanup (~15-25 items).
const GTIN_FALLBACK_CONCURRENCY = getEnvInt("WILLYS_GTIN_FALLBACK_CONCURRENCY", 3);
const GTIN_FALLBACK_MAX_PAGES = 4;
const GTIN_FALLBACK_PAGE_SIZE = 50;

// Categories within one assortment were fetched strictly one at a time
// before - there was no concurrency knob at all here, unlike Coop/ICA. Left
// tunable per-environment like the others, rather than hardcoded.
const CONCURRENCY = getEnvInt("WILLYS_FETCH_CONCURRENCY", 6);
const MAX_RETRIES = getEnvInt("WILLYS_FETCH_MAX_RETRIES", 4);

const ASSORTMENTS = [
  { slug: "willys", isHemma: false },
  { slug: "willys-hemma", isHemma: true },
];

// One set of shared collaborators for this whole run - a single client/
// logger/metrics instance so retry counts, cache hits, etc. accumulate
// across every category instead of resetting per request. cacheDir is
// omitted: Willys serves this endpoint `Cache-Control: no-store` (confirmed
// empirically), so a local response cache would never get a usable hit -
// campaign data is meant to be read fresh every time, not cached client-side.
const logger = createLogger("willys:fetch");
const metrics = createMetrics("willys-fetch");
const httpClient = createHttpClient({
  name: "willys-fetch",
  logger,
  metrics,
  maxRetries: MAX_RETRIES,
  // Willys' robots.txt declares "Crawl-delay: 10" (10s between requests). It's
  // a politeness request, not block-enforced, so dev/test stay 0 for speed;
  // production honors it via env (WILLYS_FETCH_MIN_DELAY_MS=10000). See
  // .env.example.
  minDelayMs: getEnvInt("WILLYS_FETCH_MIN_DELAY_MS", 0),
});
const checkpoint = createCheckpoint(path.join(STATE_DIR, "checkpoint.json"));
const campaignsSchemaCheck = createSchemaCheck(path.join(STATE_DIR, "schema-baseline-campaigns.json"));

// Every real Willys store belongs to one of the two shared assortments this
// scraper fetches - this picks one live store code per assortment to query
// with, since the campaigns endpoint is addressed by store, not assortment.
function pickRepresentativeStore(isHemma) {
  const stores = JSON.parse(fs.readFileSync(STORES_FILE, "utf8"));
  const match = stores.find((s) => s.name.toLowerCase().includes("hemma") === isHemma);
  if (!match) throw new Error(`No Willys store found for isHemma=${isHemma}`);
  return match.code;
}

// Willys' priceUnit carries the currency too ("kr/st", "kr/kg") - only the
// "/st"/"/kg" part matches the shared unit field every other chain's
// products use, so this strips the currency down to that.
function unitFromPriceUnit(priceUnit) {
  const match = priceUnit?.match(/\/(\w+)$/);
  return match ? `/${match[1]}` : null;
}

// Willys' API sometimes returns image paths relative to its own site rather
// than full URLs - this makes every image field usable directly, regardless
// of which form a given response happened to use.
function resolveImageUrl(image) {
  if (!image?.url) return null;
  return image.url.startsWith("http") ? image.url : `${SITE_ORIGIN}${image.url}`;
}

// Willys' API never labels a gtin/ean field directly, but its main catalog
// photos are hosted on assets.axfood.se - Axfood's shared product-image CDN
// (Willys is one of several Axfood-owned chains that draw from it, not a
// Willys-specific system) - and filed under the product's real GTIN,
// zero-padded to 14 digits (standard GS1 practice). Confirmed empirically,
// not assumed: extracting and checksum-validating this against every
// fetched product passed for 287/287 (a coincidental 13-digit number would
// only pass ~1 time in 10), and cross-checked directly against Coop/ICA's
// own independently-scraped gtin for the same physical products - e.g. Wasa
// "Sandwich 2-pack" here resolves to 7300400127363, which is exactly what
// both Coop and ICA's own offer APIs separately report as that product's
// gtin. Willys' *promotional* campaign images (res.cloudinary.com/willys-eu)
// are a different system with no such convention and are correctly left
// unmatched (null) here rather than guessed at.
function extractGtinFromImageUrl(imageUrl) {
  const match = imageUrl?.match(/assets\.axfood\.se\/image\/upload\/[^/]+\/(\d{14})_/);
  if (!match) return null;
  const candidate = match[1].slice(1);
  return isValidGtin13(candidate) ? candidate : null;
}

// rewardLabel carries the headline price exactly as Willys's UI displays it
// - for a "3 för 25:-" card that's "25,00", the total for 3, not one item's
// price. Kept exactly as scraped: priceCents is meant to be the real price
// of the deal (you can't actually buy one item for a third of it), not a
// synthetic per-item number - see the comparisonPriceCents fallback below
// for where the normalized per-item figure belongs instead. qualifyingCount
// (the "N" Willys itself resolved the deal to, confirmed to always agree
// with conditionLabel's free text "3 för") is still what dealQuantity comes
// from - just no longer used to divide priceCents down.
function mapProduct(rawItem, categoryName) {
  const promo = rawItem.potentialPromotions?.[0] ?? {};
  const originalPriceCents = parsePriceToCents(rawItem.priceNoUnit);
  const bundleCents = parsePriceToCents(promo.rewardLabel);
  const dealQuantity = Number.isInteger(promo.qualifyingCount) && promo.qualifyingCount > 1 ? promo.qualifyingCount : null;
  const priceCents = bundleCents ?? originalPriceCents;
  // Savings compares the deal's real total against what dealQuantity items
  // would have cost at the regular per-item price - not just
  // originalPriceCents itself - since the two need to describe the same
  // basket to be comparable (a bundle-of-3 total isn't comparable against a
  // single item's regular price).
  const regularTotalCents = originalPriceCents != null ? originalPriceCents * (dealQuantity ?? 1) : null;
  const savingsCents =
    regularTotalCents != null && priceCents != null && regularTotalCents > priceCents
      ? regularTotalCents - priceCents
      : null;

  // comparePrice lives on the active promotion (Willys computes it against
  // whichever price - promo or regular - is currently in effect); falls
  // back to the product-level ordinary compare price when there's no promo,
  // matching Coop/ICA's shape of "always describes the current price".
  const comparisonPriceText = promo.comparePrice ?? rawItem.promotionProductOrdinaryComparePrice ?? null;
  const comparison = parseComparisonPrice(comparisonPriceText);
  // Falls back to priceCents / dealQuantity only when Willys didn't supply
  // its own comparePrice (~5% of cases - see products/lib/comparisonPrice.js
  // for why this per-st figure is weaker than a real per-kg/per-l price).
  const fallbackComparison = !comparison ? deriveComparisonFromDealQuantity(priceCents, dealQuantity) : null;
  // promo.validUntil is epoch milliseconds (e.g. 1785103199000), unlike
  // Coop/ICA's own already-ISO validUntil/campaignEndDate - normalized here
  // so nothing downstream needs to know which chain a date came from.
  const validUntil = Number.isFinite(promo.validUntil) ? new Date(promo.validUntil).toISOString() : null;
  const validFrom = Number.isFinite(promo.startDate) ? new Date(promo.startDate).toISOString() : null;
  const image = resolveImageUrl(rawItem.image);

  return {
    title: rawItem.name ?? null,
    priceCents,
    savingsCents,
    unit: unitFromPriceUnit(rawItem.priceUnit),
    deal: promo.conditionLabel ?? null,
    dealQuantity,
    comparisonPrice: comparisonPriceText,
    comparisonPriceMinCents: comparison?.minCents ?? fallbackComparison?.minCents ?? null,
    comparisonPriceMaxCents: comparison?.maxCents ?? fallbackComparison?.maxCents ?? null,
    comparisonUnit: comparison?.unit ?? fallbackComparison?.unit ?? null,
    validFrom,
    validUntil,
    gtin: extractGtinFromImageUrl(image),
    size: rawItem.displayVolume ?? null,
    brand: rawItem.manufacturer ?? null,
    moreInfo: promo.description ?? null,
    max: promo.redeemLimitLabel ?? null,
    image,
    isMemeber: promo.campaignType === "LOYALTY",
    badges: rawItem.labels ?? [],
    categoryName,
  };
}

// Fails loudly if Willys ever changes this endpoint's response shape,
// instead of silently treating a broken/empty response as "this category
// has zero products" and quietly losing data.
function validateFacetsResponse(data) {
  if (data.facets !== undefined && !Array.isArray(data.facets)) {
    throw new Error("facets response has non-array `facets`");
  }
}

// Same reasoning as validateFacetsResponse above - a broken `results` should
// stop this category's fetch loop outright, not be read as "zero products,
// pagination complete" and quietly under-report the category.
function validateCategoryPageResponse(data) {
  if (data.results !== undefined && !Array.isArray(data.results)) {
    throw new Error("category page response has non-array `results`");
  }
}

// The one place an actual request hits Willys' campaigns endpoint - both
// the category-discovery call and every paginated product-page call route
// through here, so retry/cache/rate-limit behavior only needs wiring once.
async function fetchCampaignsPage(storeCode, query, page) {
  const qs = new URLSearchParams({ q: query, type: "GENERAL", page: String(page), size: String(PAGE_SIZE) });
  const { data } = await httpClient.fetchJson(`${BASE_URL}?${qs}`, {
    headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/json" },
  });
  return data;
}

// The bare `q=<storeCode>` query returns no per-product category, only a
// facet count summary - this is how the list of categories to fetch
// individually (each carrying its own categoryName) gets discovered.
async function fetchCategoryFacets(storeCode) {
  const data = await fetchCampaignsPage(storeCode, storeCode, 0);
  validateFacetsResponse(data);
  const facet = data.facets?.find((f) => f.code === "categoryLevel1");
  return facet?.values?.filter((v) => v.count > 0) ?? [];
}

// Accumulated across every category page fetched this run rather than
// checked once - see products/lib/schemaCheck.js for why sampling a single
// response can produce false positives on sparse/optional fields.
const campaignsSchemaAccumulator = campaignsSchemaCheck.createAccumulator();

// Pages through every product in one category until Willys' own reported
// total says there's nothing left - the endpoint caps each response to
// PAGE_SIZE items, so a category with more products than that requires
// multiple requests to read in full.
// Returns { product, mainProductCode } pairs, not bare products: mainProductCode
// (Willys' internal SKU, e.g. "101776270_ST") is kept alongside each product
// in memory to drive the GTIN fallback (recoverMissingGtins), then dropped
// before the file is written - the on-disk JSON schema is unchanged.
async function fetchCategoryProducts(storeCode, categoryCode, categoryName) {
  const query = `${storeCode}:categoryLevel1_string_mv:${categoryCode}`;
  const entries = [];
  let page = 0;
  while (true) {
    const data = await fetchCampaignsPage(storeCode, query, page);

    try {
      validateCategoryPageResponse(data);
    } catch (err) {
      metrics.recordValidationFailure();
      throw err;
    }
    campaignsSchemaAccumulator.accumulate(data);

    entries.push(
      ...(data.results ?? []).map((item) => ({
        product: mapProduct(item, categoryName),
        mainProductCode: item.potentialPromotions?.[0]?.mainProductCode ?? null,
      }))
    );
    const total = data.pagination?.totalNumberOfResults ?? entries.length;
    if (entries.length >= total || !data.results?.length) break;
    page++;
  }
  return entries;
}

// Fetches, validates, and collects one category's { product, mainProductCode }
// entries - the unit of work concurrency and error reporting operate on within
// an assortment. Checkpointing itself stays at the assortment level (see
// fetchAssortment) since that's the natural unit this scraper writes one
// output file per.
async function fetchOneCategory(storeCode, category, entries) {
  const categoryEntries = await fetchCategoryProducts(storeCode, category.code, category.name);
  logger.info("category done", { category: category.name, products: categoryEntries.length });
  entries.push(...categoryEntries);
}

// --- GTIN fallback (see products/willys/GTIN_FALLBACK_PLAN.md) -------------

async function searchCatalogPage(query, page) {
  const qs = new URLSearchParams({
    q: query,
    type: "GENERAL",
    page: String(page),
    size: String(GTIN_FALLBACK_PAGE_SIZE),
  });
  const { data } = await httpClient.fetchJson(`${SEARCH_URL}?${qs}`, {
    headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/json" },
  });
  return data;
}

// Re-finds a campaign product in Willys' regular online catalog by exact
// internal-code match (not fuzzy name matching) and reads its GTIN the same
// way as the campaign path - the catalog photo is GTIN-bearing even when the
// campaign photo isn't. Empirically resolves on page 0; paginates a few pages
// defensively since the endpoint's behavior isn't a documented contract.
async function findCatalogProductByCode(query, targetCode) {
  for (let page = 0; page < GTIN_FALLBACK_MAX_PAGES; page++) {
    const data = await searchCatalogPage(query, page);
    const hit = (data.results ?? []).find((r) => r.code === targetCode);
    if (hit) return hit;
    const totalPages = data.pagination?.numberOfPages ?? 1;
    if (page + 1 >= totalPages) return null;
  }
  return null;
}

// For each entry whose campaign image didn't yield a GTIN, look it up in the
// catalog by mainProductCode and backfill entry.product.gtin in place. A
// single failed lookup can't fail the run (runWithConcurrency isolates each).
async function recoverMissingGtins(entries) {
  const candidates = entries.filter((e) => !e.product.gtin && e.mainProductCode);
  let recovered = 0;

  await runWithConcurrency(
    candidates,
    GTIN_FALLBACK_CONCURRENCY,
    async (entry) => {
      const query = [entry.product.brand, entry.product.title].filter(Boolean).join(" ");
      if (!query) return;
      const hit = await findCatalogProductByCode(query, entry.mainProductCode);
      const gtin = hit ? extractGtinFromImageUrl(resolveImageUrl(hit.image)) : null;
      if (gtin) {
        entry.product.gtin = gtin;
        recovered++;
      }
    },
    { onFailure: (entry, err) => logger.warn("gtin fallback lookup failed", { code: entry.mainProductCode, error: err.message }) }
  );

  return { attempted: candidates.length, recovered };
}

async function fetchAssortment({ slug, isHemma }) {
  if (checkpoint.isDone(slug)) {
    logger.debug("skipping, already completed (resumed run)", { assortment: slug });
    return 0;
  }

  const storeCode = pickRepresentativeStore(isHemma);
  logger.info("fetching assortment", { assortment: slug, storeCode });

  const categories = await fetchCategoryFacets(storeCode);
  logger.info("found categories", { assortment: slug, count: categories.length });

  const entries = [];
  const { failed } = await runWithConcurrency(
    categories,
    CONCURRENCY,
    (category) => fetchOneCategory(storeCode, category, entries),
    { onFailure: (category, err) => logger.error("category fetch failed", { category: category.name, error: err.message }) }
  );
  if (failed > 0) throw new Error(`${failed}/${categories.length} categories failed for assortment "${slug}"`);

  const { attempted, recovered } = await recoverMissingGtins(entries);
  logger.info("gtin fallback done", { assortment: slug, attempted, recovered, stillMissing: attempted - recovered });

  // Drop mainProductCode - the written file's shape is exactly what it was,
  // just with fewer gtin:null entries.
  const products = entries.map((e) => e.product);
  fs.writeFileSync(path.join(DATA_DIR, `${slug}.json`), JSON.stringify(products, null, 2));
  logger.info("assortment done", { assortment: slug, products: products.length });

  // Only mark done once the file is actually written, so a crash between
  // fetch and write doesn't skip re-fetching this assortment on resume.
  checkpoint.markDone(slug);
  return products.length;
}

// Entry point: fetches both Willys assortments in one run and prints a full
// ingestion report at the end regardless of partial failures, so a
// scheduled run's health is visible from its own output, not just inferred
// from silence.
export async function fetchAllWillysStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (checkpoint.resumedCount > 0) {
    logger.info("resuming interrupted run", { alreadyDone: checkpoint.resumedCount, total: ASSORTMENTS.length });
  }

  let total = 0;
  for (const assortment of ASSORTMENTS) {
    try {
      total += await fetchAssortment(assortment);
    } catch (err) {
      logger.error("assortment fetch failed", { assortment: assortment.slug, error: err.message });
    }
  }
  logger.info("all assortments fetched", { total });

  const schemaResult = campaignsSchemaAccumulator.finish();
  if (schemaResult.changed) {
    metrics.recordSchemaChange(`campaigns: +[${schemaResult.added.join(",")}] -[${schemaResult.removed.join(",")}]`);
    logger.warn("campaigns API schema changed since last run", schemaResult);
  }

  // Reaching here means the run completed (didn't crash): both assortments
  // were attempted. Clear the checkpoint unconditionally so the next scheduled
  // run starts fresh - it exists only to resume a *crashed* run mid-way, not
  // to permanently skip an assortment that merely failed (see the fuller
  // reasoning in products/coop/fetch.js).
  checkpoint.clear();

  metrics.report();
  return { total };
}

// Only runs automatically when invoked directly - not imported/orchestrated
// alongside Coop/ICA the way products/run.js does for those two, since
// Willys' products pipeline (see products/willys/normalize.js) is invoked
// as its own separate npm script.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await fetchAllWillysStores();
}

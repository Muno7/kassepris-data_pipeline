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
import { createLogger } from "../lib/logger.js";
import { createMetrics } from "../lib/metrics.js";
import { createHttpClient } from "../lib/httpClient.js";
import { createCheckpoint } from "../lib/checkpoint.js";
import { createSchemaCheck } from "../lib/schemaCheck.js";
import { getEnvInt, DEFAULT_USER_AGENT } from "../lib/config.js";
import { runWithConcurrency } from "../lib/concurrency.js";
import { parsePriceToCents } from "../lib/priceParsing.js";
import { parseComparisonPrice } from "../lib/comparisonPrice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");
const STATE_DIR = path.resolve(__dirname, ".state");
const STORES_FILE = path.resolve(__dirname, "../../stores/willys/willys_stores.json");

const BASE_URL = "https://www.willys.se/axfood/rest/v1/search/campaigns/offline";
const SITE_ORIGIN = "https://www.willys.se";
const PAGE_SIZE = 100;

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

// rewardLabel carries the headline price exactly as Willys's UI displays it
// - for a "3 för 25:-" card that's "25,00", the total for 3, not one item's
// price (confirmed empirically: dividing by qualifyingCount and converting
// to a comparison price lines up exactly with promo.comparePrice, which
// Willys computes server-side - e.g. a 500g pack at "3 för 25,00" resolves
// to 8,33/pack, and 8,33/0,5kg = 16,66/kg, matching comparePrice "16:66
// kr/kg" exactly). Un-resolved, a multi-buy's total-for-N looks like a
// single item's price to anything comparing it against another store's
// already-per-item price - the exact bug this fixes. qualifyingCount (the
// "N" Willys itself resolved the deal to) is preferred over parsing the
// number back out of conditionLabel's free text ("3 för") since it's
// already a clean integer and confirmed to always agree with it anyway.
function mapProduct(rawItem, categoryName) {
  const promo = rawItem.potentialPromotions?.[0] ?? {};
  const originalPriceCents = parsePriceToCents(rawItem.priceNoUnit);
  const bundleCents = parsePriceToCents(promo.rewardLabel);
  const dealQuantity = Number.isInteger(promo.qualifyingCount) && promo.qualifyingCount > 1 ? promo.qualifyingCount : null;
  const priceCents = bundleCents != null ? Math.round(bundleCents / (dealQuantity ?? 1)) : originalPriceCents;
  const savingsCents =
    originalPriceCents != null && priceCents != null && originalPriceCents > priceCents
      ? originalPriceCents - priceCents
      : null;

  // comparePrice lives on the active promotion (Willys computes it against
  // whichever price - promo or regular - is currently in effect); falls
  // back to the product-level ordinary compare price when there's no promo,
  // matching Coop/ICA's shape of "always describes the current price".
  const comparisonPriceText = promo.comparePrice ?? rawItem.promotionProductOrdinaryComparePrice ?? null;
  const comparison = parseComparisonPrice(comparisonPriceText);
  // promo.validUntil is epoch milliseconds (e.g. 1785103199000), unlike
  // Coop/ICA's own already-ISO validUntil/campaignEndDate - normalized here
  // so nothing downstream needs to know which chain a date came from.
  const validUntil = Number.isFinite(promo.validUntil) ? new Date(promo.validUntil).toISOString() : null;

  return {
    title: rawItem.name ?? null,
    priceCents,
    savingsCents,
    unit: unitFromPriceUnit(rawItem.priceUnit),
    deal: promo.conditionLabel ?? null,
    dealQuantity,
    comparisonPrice: comparisonPriceText,
    comparisonPriceCents: comparison?.amountCents ?? null,
    comparisonUnit: comparison?.unit ?? null,
    validUntil,
    size: rawItem.displayVolume ?? null,
    brand: rawItem.manufacturer ?? null,
    moreInfo: promo.description ?? null,
    max: promo.redeemLimitLabel ?? null,
    image: resolveImageUrl(rawItem.image),
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
async function fetchCategoryProducts(storeCode, categoryCode, categoryName) {
  const query = `${storeCode}:categoryLevel1_string_mv:${categoryCode}`;
  const products = [];
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

    products.push(...(data.results ?? []).map((item) => mapProduct(item, categoryName)));
    const total = data.pagination?.totalNumberOfResults ?? products.length;
    if (products.length >= total || !data.results?.length) break;
    page++;
  }
  return products;
}

// Fetches, validates, and collects one category's products - the unit of
// work concurrency and error reporting operate on within an assortment.
// Checkpointing itself stays at the assortment level (see fetchAssortment)
// since that's the natural unit this scraper writes one output file per.
async function fetchOneCategory(storeCode, category, results) {
  const categoryProducts = await fetchCategoryProducts(storeCode, category.code, category.name);
  logger.info("category done", { category: category.name, products: categoryProducts.length });
  results.push(...categoryProducts);
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

  const products = [];
  const { failed } = await runWithConcurrency(
    categories,
    CONCURRENCY,
    (category) => fetchOneCategory(storeCode, category, products),
    { onFailure: (category, err) => logger.error("category fetch failed", { category: category.name, error: err.message }) }
  );
  if (failed > 0) throw new Error(`${failed}/${categories.length} categories failed for assortment "${slug}"`);

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
  let anyFailed = false;
  for (const assortment of ASSORTMENTS) {
    try {
      total += await fetchAssortment(assortment);
    } catch (err) {
      anyFailed = true;
      logger.error("assortment fetch failed", { assortment: assortment.slug, error: err.message });
    }
  }
  logger.info("all assortments fetched", { total });

  const schemaResult = campaignsSchemaAccumulator.finish();
  if (schemaResult.changed) {
    metrics.recordSchemaChange(`campaigns: +[${schemaResult.added.join(",")}] -[${schemaResult.removed.join(",")}]`);
    logger.warn("campaigns API schema changed since last run", schemaResult);
  }

  // A fully successful run means every assortment either fetched fresh or
  // was already done from a prior resume - clear the checkpoint so the next
  // scheduled run starts clean rather than skipping assortments forever.
  if (!anyFailed) checkpoint.clear();

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

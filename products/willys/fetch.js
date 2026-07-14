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

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");
const STORES_FILE = path.resolve(__dirname, "../../stores/willys/willys_stores.json");

const BASE_URL = "https://www.willys.se/axfood/rest/v1/search/campaigns/offline";
const SITE_ORIGIN = "https://www.willys.se";
const PAGE_SIZE = 100;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ASSORTMENTS = [
  { slug: "willys", isHemma: false },
  { slug: "willys-hemma", isHemma: true },
];

function pickRepresentativeStore(isHemma) {
  const stores = JSON.parse(fs.readFileSync(STORES_FILE, "utf8"));
  const match = stores.find((s) => s.name.toLowerCase().includes("hemma") === isHemma);
  if (!match) throw new Error(`No Willys store found for isHemma=${isHemma}`);
  return match.code;
}

function parsePriceToCents(str) {
  if (!str) return null;
  const match = str.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1].replace(",", "."));
  return Number.isFinite(val) ? Math.round(val * 100) : null;
}

// "kr/st" -> "/st", "kr/kg" -> "/kg"
function unitFromPriceUnit(priceUnit) {
  const match = priceUnit?.match(/\/(\w+)$/);
  return match ? `/${match[1]}` : null;
}

function resolveImageUrl(image) {
  if (!image?.url) return null;
  return image.url.startsWith("http") ? image.url : `${SITE_ORIGIN}${image.url}`;
}

// rewardLabel already carries the headline price exactly as Willys's UI
// displays it (e.g. "69,00" for a "2 för 69:-" card, not divided per unit) -
// matches what the old DOM scraper read straight off the product card, so
// `deal` (conditionLabel, e.g. "2 för") stays a separate field rather than
// being folded into the price.
function mapProduct(rawItem, categoryName) {
  const promo = rawItem.potentialPromotions?.[0] ?? {};
  const originalPriceCents = parsePriceToCents(rawItem.priceNoUnit);
  const priceCents = parsePriceToCents(promo.rewardLabel) ?? originalPriceCents;
  const savingsCents =
    originalPriceCents != null && priceCents != null && originalPriceCents > priceCents
      ? originalPriceCents - priceCents
      : null;

  return {
    title: rawItem.name ?? null,
    priceCents,
    savingsCents,
    unit: unitFromPriceUnit(rawItem.priceUnit),
    deal: promo.conditionLabel ?? null,
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

async function fetchCampaignsPage(storeCode, query, page) {
  const qs = new URLSearchParams({ q: query, type: "GENERAL", page: String(page), size: String(PAGE_SIZE) });
  const res = await fetch(`${BASE_URL}?${qs}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`API returned ${res.status} for store ${storeCode}`);
  return res.json();
}

async function fetchCategoryFacets(storeCode) {
  const data = await fetchCampaignsPage(storeCode, storeCode, 0);
  const facet = data.facets?.find((f) => f.code === "categoryLevel1");
  return facet?.values?.filter((v) => v.count > 0) ?? [];
}

async function fetchCategoryProducts(storeCode, categoryCode, categoryName) {
  const query = `${storeCode}:categoryLevel1_string_mv:${categoryCode}`;
  const products = [];
  let page = 0;
  while (true) {
    const data = await fetchCampaignsPage(storeCode, query, page);
    products.push(...(data.results ?? []).map((item) => mapProduct(item, categoryName)));
    const total = data.pagination?.totalNumberOfResults ?? products.length;
    if (products.length >= total || !data.results?.length) break;
    page++;
  }
  return products;
}

async function fetchAssortment({ slug, isHemma }) {
  const storeCode = pickRepresentativeStore(isHemma);
  console.log(`[Willys] Fetching "${slug}" via representative store ${storeCode}...`);

  const categories = await fetchCategoryFacets(storeCode);
  console.log(`  Found ${categories.length} categories`);

  const products = [];
  for (const category of categories) {
    const categoryProducts = await fetchCategoryProducts(storeCode, category.code, category.name);
    console.log(`  ${category.name}: ${categoryProducts.length} products`);
    products.push(...categoryProducts);
  }

  fs.writeFileSync(path.join(DATA_DIR, `${slug}.json`), JSON.stringify(products, null, 2));
  console.log(`[Willys] Done: ${products.length} products -> data/${slug}.json`);
  return products.length;
}

export async function fetchAllWillysStores() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let total = 0;
  for (const assortment of ASSORTMENTS) {
    total += await fetchAssortment(assortment);
  }
  console.log(`[Willys] All assortments fetched. Total products: ${total}`);
  return { total };
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await fetchAllWillysStores();
}

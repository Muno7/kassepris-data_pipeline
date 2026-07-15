// Step 1: FETCH (general catalog, not deals)
//
// Coop's "handla online" section is powered by a Loop54-based search service
// - a different backend from the Hybris-based offers API dke/fetch.js uses,
// discovered by capturing real browser network traffic against a category
// page (its endpoints never show up in the static JS bundle, since they're
// only referenced through minified indirection).
//
// Two calls:
//  1. GET the category tree once - gives every leaf category's numeric code,
//     which the search call needs (no need to scrape the sitemap for this).
//  2. POST a paginated product search per leaf category.
//
// `store` here isn't one of the 779 real physical stores already in our
// `stores` table - it's the generic default id Coop's site falls back to
// when no delivery address is set, i.e. this is Coop's one shared online
// catalog/price list, not a specific store's assortment or price.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "catalog_data");

const BASE_URL = "https://external.api.coop.se";
const DEFAULT_STORE = "251300";
const PAGE_SIZE = 48;
const CONCURRENCY = 8;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Public client key shipped in Coop's own frontend bundle, shared across
// most of its external.api.coop.se services (personalization/ecommerce) -
// distinct from products/coop/fetch.js's PRODUCTS_SUBSCRIPTION_KEY, which
// only works against the older Hybris offers API.
const SUBSCRIPTION_KEY = "3becf0ce306f41a1ae94077c16798187";

const HEADERS = {
  "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": USER_AGENT,
  Origin: "https://www.coop.se",
  Referer: "https://www.coop.se/",
};

// Fallback identity for items without an ean. Excludes image/categoryName/
// fingerprint itself - matches the pattern in products/coop/fetch.js.
function generateFingerprint(productData) {
  const { categoryName, fingerprint, image, gtin, ...rest } = productData;
  return Object.values(rest)
    .map((v) => (v === null || v === undefined ? "NULL" : String(v).toUpperCase().replace(/\s/g, "")))
    .join("");
}

function mapProduct(rawItem, categoryName) {
  const productData = {
    title: rawItem.name ?? null,
    priceCents:
      rawItem.salesPriceData?.b2cPrice != null ? Math.round(rawItem.salesPriceData.b2cPrice * 100) : null,
    comparisonPrice: rawItem.comparativePriceText ?? null,
    size: rawItem.packageSizeInformation ?? null,
    brand: rawItem.manufacturerName ?? null,
    image: rawItem.imageUrl ?? null,
    gtin: rawItem.ean ?? null,
    categoryName,
  };
  productData.fingerprint = generateFingerprint(productData);
  return productData;
}

async function fetchCategoryTree() {
  const res = await fetch(`${BASE_URL}/ecommerce/coop/users/anonymous/categories/tree/${DEFAULT_STORE}?api-version=v1`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`Category tree API returned ${res.status}`);
  return res.json();
}

// Leaves are tagged with their top-level ancestor's name (e.g. "Ost" under
// "Mejeri & ägg") - this is the catalog's own taxonomy, coarser-grained but
// differently organized than the offers API's categoryTeam used for deals,
// so it needs its own mapping in normalize_catalog.js rather than reusing
// COOP_CATEGORY_MAP.
function collectLeafCategories(nodes, topLevelName = null) {
  const leaves = [];
  for (const node of nodes) {
    const label = topLevelName ?? node.name;
    if (node.children.length === 0) {
      leaves.push({ code: node.code, name: node.name, topLevelName: label });
    } else {
      leaves.push(...collectLeafCategories(node.children, label));
    }
  }
  return leaves;
}

async function fetchCategoryPage(categoryCode, skip) {
  const res = await fetch(
    `${BASE_URL}/personalization/search/entities/by-attribute?api-version=v1&store=${DEFAULT_STORE}&groups=CUSTOMER_PRIVATE&device=desktop&direct=false`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        attribute: { name: "categoryIds", value: categoryCode },
        resultsOptions: { skip, take: PAGE_SIZE, sortBy: [], facets: [] },
        customData: { getEntitiesByAttributeABTest: false, consent: false },
      }),
    }
  );
  if (!res.ok) throw new Error(`API returned ${res.status} for category ${categoryCode}`);
  return res.json();
}

async function fetchOneCategory(leaf) {
  const products = [];
  let skip = 0;
  while (true) {
    const data = await fetchCategoryPage(leaf.code, skip);
    const items = data.results?.items ?? [];
    products.push(...items.map((item) => mapProduct(item, leaf.topLevelName)));
    const total = data.results?.count ?? products.length;
    if (products.length >= total || items.length === 0) break;
    skip += PAGE_SIZE;
  }

  fs.writeFileSync(path.join(DATA_DIR, `${leaf.code}.json`), JSON.stringify(products, null, 2));
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
        console.warn(`  Failed "${item.name}" (${item.code}): ${err.message}`);
      }
      if ((ok + failed) % 50 === 0) console.log(`  Progress: ${ok + failed}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, next));
  return { ok, failed };
}

export async function fetchCoopCatalog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log("[Coop] Fetching category tree...");
  const tree = await fetchCategoryTree();
  const leaves = collectLeafCategories(tree.nodes);
  console.log(`[Coop] Found ${leaves.length} leaf categories`);

  console.log(`[Coop] Fetching catalog products (concurrency ${CONCURRENCY})...`);
  const { ok, failed } = await runWithConcurrency(leaves, CONCURRENCY, fetchOneCategory);
  console.log(`[Coop] Done: ${ok} categories fetched, ${failed} failed. Raw output -> ${DATA_DIR}`);
  return { ok, failed, total: leaves.length };
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await fetchCoopCatalog();
}

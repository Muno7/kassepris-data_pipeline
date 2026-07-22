// Step 2: NORMALIZE (general catalog, not deals)
//
// Reads every raw per-category file out of catalog_data/, converts each item
// into the shared display shape, and deduplicates by gtin (falling back to
// fingerprint) - a product can legitimately show up under more than one leaf
// category (or more than once within one), so first occurrence wins, same as
// products/coop/normalize.js's cross-store dedup. Unlike the deals pipeline
// there's no per-store price to collect into a storeOffers array - this is
// one shared online price per product, written straight onto the row.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISPLAY_CATEGORIES } from "../categories/displayCategories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "catalog_data");
const OUTPUT_FILE = path.resolve(__dirname, "normalized/coop_catalog_normalized.json");

// Coop's general catalog uses its own top-level taxonomy (21 categories),
// coarser and differently split than the offers API's categoryTeam used for
// deals (see products/coop/fetch.js's TEAM_TO_BUTTON_CATEGORY) - e.g. "Ost"
// and "Fisk & skaldjur" are their own top-level buckets here, folded into
// "Mejeri & ägg" / "Fågel, fisk & kött" on the deals side.
const COOP_CATALOG_CATEGORY_MAP = {
  "Kiosk & tidningar": "other",
  "Frukt & grönsaker": "fruit_and_vegetables",
  "Kött, fågel & chark": "fresh_food",
  "Fisk & skaldjur": "fresh_food",
  "Mejeri & ägg": "dairy_and_eggs",
  Ost: "dairy_and_eggs",
  Vegetariskt: "other",
  Frys: "frozen_food",
  Dryck: "drinks",
  Skafferi: "pantry",
  "Bröd & bageri": "bread_and_bakery",
  "Godis, glass & snacks": "snacks_and_sweets",
  "Färdigmat & mellanmål": "fresh_food",
  "Kryddor & smaksättare": "pantry",
  Barn: "other",
  Hushåll: "home_and_leisure",
  "Skönhet & hygien": "health_and_beauty",
  Fritid: "home_and_leisure",
  "Apotek, hälsa & tillskott": "health_and_beauty",
  "Hem & inredning": "home_and_leisure",
  Delikatesser: "fresh_food",
  "Djurmat & tillbehör": "other",
};

function removeTrailingPeriod(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\.+$/, "");
}

function normalizeProduct(rawProduct) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = COOP_CATALOG_CATEGORY_MAP[rawCategory];
  if (!displayCategoryKey) throw new Error(`Unknown Coop catalog category: "${rawCategory}"`);
  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];

  return {
    gtin: rawProduct.gtin || null,
    fingerprint: rawProduct.fingerprint,

    title: removeTrailingPeriod(rawProduct.title),
    image: rawProduct.image,
    brand: rawProduct.brand,
    size: removeTrailingPeriod(rawProduct.size),

    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,

    priceCents: rawProduct.priceCents,
    comparisonPrice: removeTrailingPeriod(rawProduct.comparisonPrice),
    comparisonPriceCents: rawProduct.comparisonPriceCents ?? null,
    comparisonUnit: rawProduct.comparisonUnit ?? null,
  };
}

export function normalizeCoopCatalog() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  console.log(`[Coop] Normalizing ${files.length} catalog category files...`);

  const productMap = new Map();
  let totalProcessed = 0;
  let errors = 0;

  for (const file of files) {
    const rawProducts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
    for (const rawProduct of rawProducts) {
      try {
        const normalized = normalizeProduct(rawProduct);
        const key = normalized.gtin || normalized.fingerprint;
        if (!productMap.has(key)) productMap.set(key, normalized);
        totalProcessed++;
      } catch (err) {
        errors++;
      }
    }
  }

  const normalizedProducts = Array.from(productMap.values());
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(normalizedProducts, null, 2));

  console.log(
    `[Coop] Done: ${totalProcessed} raw catalog items -> ${normalizedProducts.length} unique products` +
      (errors > 0 ? ` (${errors} errors)` : "") +
      `. Output -> ${OUTPUT_FILE}`
  );
  return { totalProcessed, unique: normalizedProducts.length, errors };
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  normalizeCoopCatalog();
}

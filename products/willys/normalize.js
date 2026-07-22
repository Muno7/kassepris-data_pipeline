// Step 2: NORMALIZE
//
// Reads the two assortment files out of data/ (willys.json, willys-hemma.json
// - not one file per store, since Willys groups all stores into one of these
// two shared newspaper assortments, confirmed identical across every store
// within each), converts each product into the shared display shape, and
// deduplicates by fingerprint (Willys's scraper doesn't extract a barcode,
// so there's no gtin to prefer) into one product with a `storeOffers` array -
// same shape Coop/ICA use.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISPLAY_CATEGORIES } from "../categories/displayCategories.js";
import { WILLYS_BADGE_MAP, normalizeBadges } from "../categories/badges.js";
import { buildFingerprint } from "../lib/fingerprint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");
const OUTPUT_FILE = path.resolve(__dirname, "normalized/willys_normalized.json");

const ASSORTMENT_FILES = [
  { file: "willys.json", store: "willys" },
  { file: "willys-hemma.json", store: "willys-hemma" },
];

const WILLYS_CATEGORY_MAP = {
  Apotek: "health_and_beauty",
  Barn: "other",
  "Blommor & trädgård": "home_and_leisure",
  "Bröd & Kakor": "bread_and_bakery",
  Djur: "other",
  Dryck: "drinks",
  "Fisk & Skaldjur": "fresh_food",
  "Frukt & Grönt": "fruit_and_vegetables",
  Fryst: "frozen_food",
  Färdigmat: "fresh_food",
  "Glass, godis & snacks": "snacks_and_sweets",
  "Hem & Städ": "home_and_leisure",
  "Hälsa & Skönhet": "health_and_beauty",
  "Kött, chark & fågel": "fresh_food",
  "Mejeri, ost & ägg": "dairy_and_eggs",
  Skafferi: "pantry",
  Vegetariskt: "other",
};

function removeTrailingPeriod(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\.+$/, "");
}

// Willys raw data splits the "more info" text into two parts (moreInfo, max)
// instead of a single field like Coop/ICA, so combine whatever is present.
function combineMoreInfo(rawProduct) {
  return [rawProduct.moreInfo, rawProduct.max].filter(Boolean).join(" · ") || null;
}

// Identity fields only - title/size/brand, the same subset Coop/ICA build
// their fallback fingerprint from (see products/coop/fetch.js's
// generateFingerprint for the full reasoning). Deliberately excludes every
// price/deal field: confirmed empirically that 48 of 86 products priced
// differently between the willys/willys-hemma assortments, so including
// price here would fingerprint the same physical product differently
// depending on which assortment it was read from, splitting what should be
// one product + two storeOffers into two unlinked products instead - and
// would keep re-splitting it every time either assortment's price changed
// week over week.
function generateFingerprint(title, size, brand) {
  return buildFingerprint({ title, size, brand });
}

function normalizeProduct(rawProduct, store) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = WILLYS_CATEGORY_MAP[rawCategory];
  if (!displayCategoryKey) throw new Error(`Unknown Willys category: "${rawCategory}"`);
  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];

  const title = removeTrailingPeriod(rawProduct.title);
  const size = removeTrailingPeriod(rawProduct.size);
  const fingerprint = generateFingerprint(title, size, rawProduct.brand);

  return {
    gtin: null,
    fingerprint,
    variantGroup: null,

    title,
    image: rawProduct.image,
    brand: rawProduct.brand,
    size,

    moreInfo: removeTrailingPeriod(combineMoreInfo(rawProduct)),
    badges: normalizeBadges(rawProduct.badges, WILLYS_BADGE_MAP),

    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,

    storeOffer: {
      store,
      priceCents: rawProduct.priceCents,
      savingsCents: rawProduct.savingsCents,
      unit: rawProduct.unit,
      comparisonPrice: rawProduct.comparisonPrice ?? null,
      comparisonPriceCents: rawProduct.comparisonPriceCents ?? null,
      comparisonUnit: rawProduct.comparisonUnit ?? null,
      deal: rawProduct.deal,
      dealQuantity: rawProduct.dealQuantity ?? null,
      isMember: rawProduct.isMemeber,
      validUntil: rawProduct.validUntil ?? null,
    },
  };
}

export function normalizeAllWillysStores() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const productMap = new Map();
  let totalProcessed = 0;
  let errors = 0;

  for (const { file, store } of ASSORTMENT_FILES) {
    const inputPath = path.join(DATA_DIR, file);
    if (!fs.existsSync(inputPath)) {
      console.warn(`[Willys] File not found: ${inputPath}, skipping "${store}"`);
      continue;
    }

    const rawProducts = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    console.log(`[Willys] Found ${rawProducts.length} products in "${store}"`);

    for (const rawProduct of rawProducts) {
      try {
        const normalized = normalizeProduct(rawProduct, store);
        const key = normalized.gtin || normalized.fingerprint;
        const existing = productMap.get(key);
        if (existing) {
          if (!existing.storeOffers.some((o) => o.store === normalized.storeOffer.store)) {
            existing.storeOffers.push(normalized.storeOffer);
          }
        } else {
          const { storeOffer, ...identity } = normalized;
          productMap.set(key, { ...identity, storeOffers: [storeOffer] });
        }
        totalProcessed++;
      } catch (err) {
        errors++;
      }
    }
  }

  const normalizedProducts = Array.from(productMap.values());
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(normalizedProducts, null, 2));

  console.log(
    `[Willys] Done: ${totalProcessed} raw products -> ${normalizedProducts.length} unique products` +
      (errors > 0 ? ` (${errors} errors)` : "") +
      `. Output -> ${OUTPUT_FILE}`
  );
  return { totalProcessed, unique: normalizedProducts.length, errors };
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  normalizeAllWillysStores();
}

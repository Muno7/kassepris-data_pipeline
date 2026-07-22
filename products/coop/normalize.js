// Step 2: NORMALIZE
//
// Reads every raw per-store file out of data/, converts each product into
// the shared display shape, and deduplicates products that exist in multiple
// stores - keyed by gtin (the real barcode) when the offer has one, falling
// back to the text fingerprint otherwise - collapsing them into one product
// with a `storeOffers` array. Price/deal/validUntil stay per-store (a real
// price-comparison product), not collapsed onto the product itself.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DISPLAY_CATEGORIES } from "../categories/displayCategories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "data");
const OUTPUT_FILE = path.resolve(__dirname, "normalized/coop_normalized.json");

const COOP_CATEGORY_MAP = {
  "Fågel, fisk & kött": "fresh_food",
  "Deli & chark": "fresh_food",
  "Frukt & grönt": "fruit_and_vegetables",
  "Mejeri & ägg": "dairy_and_eggs",
  "Bröd & bageri": "bread_and_bakery",
  Frysvaror: "frozen_food",
  Skafferi: "pantry",
  "Godis & snacks": "snacks_and_sweets",
  "Kaffe & dryck": "drinks",
  "Hem & fritid": "home_and_leisure",
};

function removeTrailingPeriod(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\.+$/, "");
}

function normalizeProduct(rawProduct) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = COOP_CATEGORY_MAP[rawCategory];
  if (!displayCategoryKey) throw new Error(`Unknown Coop category: "${rawCategory}"`);
  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];

  return {
    gtin: rawProduct.gtin || null,
    fingerprint: rawProduct.fingerprint,
    variantGroup: rawProduct.variantGroup || null,

    title: removeTrailingPeriod(rawProduct.title),
    image: rawProduct.image,
    brand: rawProduct.brand,
    size: removeTrailingPeriod(rawProduct.size),

    moreInfo: removeTrailingPeriod(rawProduct.max),
    badges: rawProduct.badges,

    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,

    storeOffer: {
      store: rawProduct.store,
      priceCents: rawProduct.priceCents,
      savingsCents: rawProduct.savingsCents,
      unit: rawProduct.unit,
      comparisonPrice: removeTrailingPeriod(rawProduct.comparisonPrice),
      comparisonPriceCents: rawProduct.comparisonPriceCents ?? null,
      comparisonUnit: rawProduct.comparisonUnit ?? null,
      deal: rawProduct.deal,
      dealQuantity: rawProduct.dealQuantity ?? null,
      isMember: rawProduct.isMember,
      validUntil: rawProduct.validUntil || null,
    },
  };
}

export function normalizeAllCoopStores() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  console.log(`[Coop] Normalizing ${files.length} store files...`);

  const productMap = new Map();
  let totalProcessed = 0;
  let errors = 0;

  for (const file of files) {
    const rawProducts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
    for (const rawProduct of rawProducts) {
      try {
        const normalized = normalizeProduct(rawProduct);
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
    `[Coop] Done: ${totalProcessed} raw products -> ${normalizedProducts.length} unique products` +
      (errors > 0 ? ` (${errors} errors)` : "") +
      `. Output -> ${OUTPUT_FILE}`
  );
  return { totalProcessed, unique: normalizedProducts.length, errors };
}

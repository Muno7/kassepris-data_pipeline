// Step 2: NORMALIZE
//
// Reads every raw per-store file out of data/, converts each product into
// the shared display shape, and deduplicates products that exist in multiple
// stores - keyed by gtin (the real barcode) when the offer has one, falling
// back to the text fingerprint otherwise - collapsing them into one product
// with a `storeOffers` array. Price/deal/validUntil stay per-store - ICA
// stores are independently owned, so the same product's price genuinely
// varies between them (confirmed: ~37% of products have >1 distinct price
// across stores), unlike Coop where it barely does.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dataDir, normalizedFile } from "../lib/paths.js";
import { DISPLAY_CATEGORIES } from "../categories/displayCategories.js";
import { ICA_TRAIT_MAP, normalizeBadges } from "../categories/badges.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = dataDir("ica");
const OUTPUT_FILE = normalizedFile("ica");

const ICA_CATEGORY_MAP = {
  Färskvaror: "fresh_food",
  Mejeri: "dairy_and_eggs",
  Djupfryst: "frozen_food",
  "Bröd, kex & bageri": "bread_and_bakery",
  Skafferivaror: "pantry",
  "Hem & fritid": "home_and_leisure",
  "Frukt & Grönt": "fruit_and_vegetables",
  "Hälsa & skönhet": "health_and_beauty",
  Ospecificerat: "other",
};

function removeTrailingPeriod(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\.+$/, "");
}

function normalizeProduct(rawProduct) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = ICA_CATEGORY_MAP[rawCategory];
  if (!displayCategoryKey) throw new Error(`Unknown ICA category: "${rawCategory}"`);
  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];

  return {
    gtin: rawProduct.gtin || null,
    fingerprint: rawProduct.fingerprint,
    variantGroup: rawProduct.variantGroup || null,

    title: removeTrailingPeriod(rawProduct.title),
    image: rawProduct.image,
    brand: rawProduct.brand,
    size: removeTrailingPeriod(rawProduct.size),

    moreInfo: removeTrailingPeriod(rawProduct.moreInfo),
    badges: normalizeBadges(rawProduct.traits, ICA_TRAIT_MAP),

    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,

    storeOffer: {
      store: rawProduct.store,
      priceCents: rawProduct.priceCents,
      savingsCents: rawProduct.savingsCents,
      unit: rawProduct.unit,
      comparisonPrice: removeTrailingPeriod(rawProduct.comparisonPrice),
      comparisonPriceMinCents: rawProduct.comparisonPriceMinCents ?? null,
      comparisonPriceMaxCents: rawProduct.comparisonPriceMaxCents ?? null,
      comparisonUnit: rawProduct.comparisonUnit ?? null,
      deal: rawProduct.deal,
      dealQuantity: rawProduct.dealQuantity ?? null,
      isMember: rawProduct.isMember,
      validFrom: rawProduct.validFrom || null,
      validUntil: rawProduct.validUntil || null,
    },
  };
}

export function normalizeAllIcaStores() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  console.log(`[ICA] Normalizing ${files.length} store files...`);

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
    `[ICA] Done: ${totalProcessed} raw products -> ${normalizedProducts.length} unique products` +
      (errors > 0 ? ` (${errors} errors)` : "") +
      `. Output -> ${OUTPUT_FILE}`
  );
  return { totalProcessed, unique: normalizedProducts.length, errors };
}

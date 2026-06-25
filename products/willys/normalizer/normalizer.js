import { DISPLAY_CATEGORIES } from '../../categories/displayCategories.js';

const WILLYS_CATEGORY_MAP = {
  'Barn': 'other',
  'Blommor & trädgård': 'home_and_leisure',
  'Bröd & Kakor': 'bread_and_bakery',
  'Djur': 'other',
  'Dryck': 'drinks',
  'Fisk & Skaldjur': 'fresh_food',
  'Frukt & Grönt': 'fruit_and_vegetables',
  'Fryst': 'frozen_food',
  'Färdigmat': 'fresh_food',
  'Glass, godis & snacks': 'snacks_and_sweets',
  'Hem & Städ': 'home_and_leisure',
  'Hälsa & Skönhet': 'health_and_beauty',
  'Kött, chark & fågel': 'fresh_food',
  'Mejeri, ost & ägg': 'dairy_and_eggs',
  'Skafferi': 'pantry',
  'Vegetariskt': 'other',
};

/**
 * Removes trailing periods from a string
 */
function removeTrailingPeriod(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\.+$/, '');
}

/**
 * Willys raw data splits the "more info" text into two parts (moreInfo, max)
 * instead of a single field like Coop/ICA, so combine whatever is present.
 */
function combineMoreInfo(rawProduct) {
  return [rawProduct.moreInfo, rawProduct.max]
    .filter(Boolean)
    .join(' · ') || null;
}

function generateFingerprint(productData) {
  // Create fingerprint from all properties except badges, categoryName, store,
  // fingerprint, image, and moreInfo/max (mirrors Coop/ICA, which also exclude
  // the restriction/info text since it's not part of the product's identity)
  const { badges, categoryName, store, fingerprint, image, moreInfo, ...fingerprintProps } = productData;
  const fingerprints = Object.values(fingerprintProps)
    .map(v => {
      if (v === null || v === undefined) {
        return 'NULL';
      }
      return String(v).toUpperCase().replace(/\s/g, '');
    })
    .join('');
  return fingerprints;
}

export function normalizeWillysProduct(rawProduct, storeCode) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = WILLYS_CATEGORY_MAP[rawCategory];

  if (!displayCategoryKey) {
    throw new Error(
      `Unknown Willys category: "${rawCategory}"`
    );
  }

  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];

  const productData = {
    title: removeTrailingPeriod(rawProduct.title),
    priceCents: rawProduct.priceCents,
    unit: rawProduct.unit,
    deal: rawProduct.deal,
    size: removeTrailingPeriod(rawProduct.size),
    brand: rawProduct.brand,
    isMember: rawProduct.isMemeber,
  };

  const fingerprint = generateFingerprint(productData);

  return {
    // identity
    fingerprint,
    stores: [storeCode], // Array for deduplication

    // display
    title: productData.title,
    image: rawProduct.image,
    brand: productData.brand,
    size: productData.size,

    // pricing
    priceCents: productData.priceCents,
    unit: productData.unit,
    comparisonPrice: null, // not extracted by the Willys scraper
    deal: productData.deal,
    isMember: productData.isMember,

    // restrictions & badges
    moreInfo: removeTrailingPeriod(combineMoreInfo(rawProduct)),
    badges: rawProduct.badges,

    // categorization
    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,

    // variants (the Willys scraper doesn't extract these)
    variants: false,
  };
}

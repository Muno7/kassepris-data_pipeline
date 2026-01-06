// normalizers/normalizeIcaProduct.js
import { DISPLAY_CATEGORIES } from '../../categories/displayCategories.js';

const ICA_CATEGORY_MAP = {
    "Färskvaror": "fresh_food",
    "Mejeri": "dairy_and_eggs",
    "Djupfryst": "frozen_food",
    "Bröd, kex & bageri": "bread_and_bakery",
    "Skafferivaror": "pantry",
    "Hem & fritid": "home_and_leisure",
    "Frukt & Grönt": "fruit_and_vegetables",
    "Hälsa & skönhet": "health_and_beauty",
    "Ospecificerat": "other",
}

/**
 * Removes trailing periods from a string
 */
function removeTrailingPeriod(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\.+$/, '');
}

/**
 * Normalizes a product variant to match Coop structure
 * Inherits missing fields from parent product
 */
function normalizeVariant(variant, parentProduct) {
  return {
    // display
    title: removeTrailingPeriod(variant.name || parentProduct.title),
    image: variant.picture || parentProduct.image,
    brand: parentProduct.brand,
    size: parentProduct.size,
    
    // pricing (inherited from parent)
    priceCents: parentProduct.priceCents,
    unit: parentProduct.unit,
    comparisonPrice: parentProduct.comparisonPrice,
    deal: parentProduct.deal,
    isMember: parentProduct.isMember,
    
    // restrictions & badges (inherited from parent)
    moreInfo: parentProduct.moreInfo,
    badges: [],
  };
}

export function normalizeIcaProduct(rawProduct) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = ICA_CATEGORY_MAP[rawCategory];
  
  if (!displayCategoryKey) {
    throw new Error(
      `Unknown ICA category: "${rawCategory}"`
    );
  }
  
  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];
  
  // Normalize variants if they exist
  const variants = rawProduct.variants && rawProduct.variants.length > 0 
    ? rawProduct.variants.map(v => normalizeVariant(v, rawProduct))
    : false;
  
  return {
    // identity
    fingerprint: rawProduct.fingerprint,
    stores: [rawProduct.store], // Array for deduplication
    
    // display
    title: removeTrailingPeriod(rawProduct.title),
    image: rawProduct.image,
    brand: rawProduct.brand,
    size: removeTrailingPeriod(rawProduct.size),
    
    // pricing
    priceCents: rawProduct.priceCents,
    unit: rawProduct.unit,
    comparisonPrice: removeTrailingPeriod(rawProduct.comparisonPrice),
    deal: rawProduct.deal,
    isMember: rawProduct.isMember,
    
    // restrictions & badges
    moreInfo: removeTrailingPeriod(rawProduct.moreInfo), // ICA uses "moreInfo" instead of "max"
    badges: [], // ICA doesn't have badges, so empty array
    
    // categorization
    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,
    
    // variants (normalized or false)
    variants: variants,
  };
}
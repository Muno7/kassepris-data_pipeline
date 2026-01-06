
import fs from 'fs';
import { DISPLAY_CATEGORIES } from '../../categories/displayCategories.js';

const COOP_CATEGORY_MAP = {
  'Fågel, fisk & kött': 'fresh_food',
  'Deli & chark': 'fresh_food',
  'Frukt & grönt': 'fruit_and_vegetables',
  'Mejeri & ägg': 'dairy_and_eggs',
  'Bröd & bageri': 'bread_and_bakery',
  'Frysvaror': 'frozen_food',
  'Skafferi': 'pantry',
  'Godis & snacks': 'snacks_and_sweets',
  'Kaffe & dryck': 'drinks',
  'Hem & fritid': 'home_and_leisure',
};

/**
 * Removes trailing periods from a string
 */
function removeTrailingPeriod(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\.+$/, '');
}

/**
 * Normalizes a product variant (without category/store/fingerprint)
 */
function normalizeVariant(variant) {
  return {
    // display
    title: removeTrailingPeriod(variant.title),
    image: variant.image,
    brand: variant.brand,
    size: removeTrailingPeriod(variant.size),
    
    // pricing
    priceCents: variant.priceCents,
    unit: variant.unit,
    comparisonPrice: removeTrailingPeriod(variant.comparisonPrice),
    deal: variant.deal,
    isMember: variant.isMember,
    
    // restrictions & badges
    moreInfo: removeTrailingPeriod(variant.max),
    badges: variant.badges ?? [],
  };
}

export function normalizeCoopProduct(rawProduct) {
  const rawCategory = rawProduct.categoryName;
  const displayCategoryKey = COOP_CATEGORY_MAP[rawCategory];
  
  if (!displayCategoryKey) {
    throw new Error(
      `Unknown Coop category: "${rawCategory}"`
    );
  }
  
  const displayCategory = DISPLAY_CATEGORIES[displayCategoryKey];
  
  // Normalize variants if they exist
  const variants = rawProduct.variants && rawProduct.variants.length > 0 
    ? rawProduct.variants.map(v => normalizeVariant(v))
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
    moreInfo: removeTrailingPeriod(rawProduct.max),
    badges: rawProduct.badges,
    
    // categorization
    categorySlug: displayCategory.slug,
    categoryName: displayCategory.name,
    rawCategoryName: rawCategory,
    
    // variants (normalized or false)
    variants: variants,
  };
}
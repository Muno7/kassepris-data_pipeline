// Maps each chain's raw badge/label/trait codes into one consistent
// {slug, label, type, icon} shape, the same way displayCategories.js
// normalizes category names - so the app never needs per-chain logic to
// render a badge, just `badge.label`/`badge.icon` directly.
//
// Coop has no source data for badges at all currently (not a bug - its
// product cards just don't carry this kind of label), so it always produces
// an empty array; nothing to map there yet.

const WILLYS_ICON_BASE = "https://www.willys.se/icons/labels";

// Willys's raw `labels` codes (products/willys/fetch.js's `rawItem.labels`).
// `icon` is the same icons/labels/{code}.svg URL the old DOM scraper used to
// read straight off rendered <img> tags - confirmed live that most codes
// still resolve to a real icon under that path; the few hazard symbols below
// don't (no reliable filename found for them), so those stay icon: null
// rather than link a guessed, possibly-broken URL.
export const WILLYS_BADGE_MAP = {
  ecological: { slug: "ecological", label: "Ekologisk", type: "certification", icon: null },
  eu_ecological: { slug: "eu_ecological", label: "EU Ekologiskt", type: "certification", icon: `${WILLYS_ICON_BASE}/eu_ecological.svg` },
  krav: { slug: "krav", label: "KRAV-märkt", type: "certification", icon: `${WILLYS_ICON_BASE}/krav.svg` },
  swan: { slug: "swan", label: "Svanenmärkt", type: "certification", icon: `${WILLYS_ICON_BASE}/swan.svg` },
  keyhole: { slug: "keyhole", label: "Nyckelhålet", type: "certification", icon: `${WILLYS_ICON_BASE}/keyhole.svg` },
  msc_fish: { slug: "msc_fish", label: "MSC-märkt fisk", type: "certification", icon: `${WILLYS_ICON_BASE}/msc_fish.svg` },
  asc_fish: { slug: "asc_fish", label: "ASC-märkt fisk", type: "certification", icon: `${WILLYS_ICON_BASE}/asc_fish.svg` },
  rainforest_alliance: { slug: "rainforest_alliance", label: "Rainforest Alliance", type: "certification", icon: `${WILLYS_ICON_BASE}/rainforest_alliance.svg` },
  environmental_choice: { slug: "environmental_choice", label: "Miljöval", type: "certification", icon: `${WILLYS_ICON_BASE}/environmental_choice.svg` },
  environmental_facet: { slug: "environmental_facet", label: "Miljömärkt", type: "certification", icon: null },

  glutenfree: { slug: "glutenfree", label: "Glutenfri", type: "dietary", icon: `${WILLYS_ICON_BASE}/glutenfree.svg` },
  laktosfree: { slug: "laktosfree", label: "Laktosfri", type: "dietary", icon: `${WILLYS_ICON_BASE}/laktosfree.svg` },
  allergy_approved: { slug: "allergy_approved", label: "Allergikorrekt", type: "dietary", icon: `${WILLYS_ICON_BASE}/allergy_approved.svg` },

  from_sweden: { slug: "from_sweden", label: "Från Sverige", type: "origin", icon: `${WILLYS_ICON_BASE}/from_sweden.svg` },
  meat_from_sweden: { slug: "meat_from_sweden", label: "Kött från Sverige", type: "origin", icon: `${WILLYS_ICON_BASE}/meat_from_sweden.svg` },
  milk_from_sweden: { slug: "milk_from_sweden", label: "Mjölk från Sverige", type: "origin", icon: `${WILLYS_ICON_BASE}/milk_from_sweden.svg` },
  swedish_flag: { slug: "swedish_flag", label: "Svensk vara", type: "origin", icon: `${WILLYS_ICON_BASE}/swedish_flag.svg` },

  frozen: { slug: "frozen", label: "Fryst", type: "storage", icon: `${WILLYS_ICON_BASE}/frozen.svg` },

  age_restricted_15: { slug: "age_restricted_15", label: "15 år", type: "age_restriction", icon: `${WILLYS_ICON_BASE}/age_restricted_15.svg` },

  danger: { slug: "danger", label: "Fara", type: "hazard", icon: null },
  warning: { slug: "warning", label: "Varning", type: "hazard", icon: null },
  exclamation_mark: { slug: "exclamation_mark", label: "Hälsoskadlig", type: "hazard", icon: null },
  flame: { slug: "flame", label: "Brandfarlig", type: "hazard", icon: null },
  corrosion: { slug: "corrosion", label: "Frätande", type: "hazard", icon: null },

  // Means "no icon assigned" on Willys's own site - not a real badge.
  no_pictogram: null,
};

// ICA's raw `traits` values (products/ica/fetch.js's `offer.traits`) - text
// stickers only on ICA's own site, no icon to link.
// "Stammis" is also used separately to set isMember, but it's kept here too
// so the UI can show the sticker without re-deriving it from isMember.
export const ICA_TRAIT_MAP = {
  Stammis: { slug: "stammis", label: "Stammis-erbjudande", type: "loyalty", icon: null },
  Butiksunikt: { slug: "butiksunikt", label: "Butiksunikt", type: "store_specific", icon: null },
  Klipp: { slug: "klipp", label: "Klipp", type: "deal_type", icon: null },
  Superklipp: { slug: "superklipp", label: "Superklipp", type: "deal_type", icon: null },
};

export function normalizeBadges(rawCodes, map) {
  if (!rawCodes || rawCodes.length === 0) return [];
  const badges = [];
  for (const code of rawCodes) {
    const mapped = map[code];
    if (mapped === undefined) {
      console.warn(`Unknown badge code: "${code}"`);
      continue;
    }
    if (mapped === null) continue; // explicitly excluded (e.g. "no_pictogram")
    badges.push(mapped);
  }
  return badges;
}

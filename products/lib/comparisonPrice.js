// Every chain also prints a "jämförpris" (comparison price) alongside the
// sticker price - e.g. "108:70/kg", "73,20/kg.", "16:66 kr/kg" - the one
// price that's actually safe to compare across two offers with different
// pack sizes or multi-buy deals. This is the one place that turns that text
// into a number + a normalized unit, so nothing downstream ever compares two
// prices that aren't denominated the same way.
//
// Confirmed empirically across real Coop/ICA/Willys responses that this text
// is far messier than the main price: the decimal separator alone varies
// (Coop uses a comma - "73,20"; ICA and Willys use a colon - "16:66"), Coop
// trails every value with a period, and the unit half carries a long tail of
// non-comparable qualifiers - "/kgutanspad" (per kg drained weight, for
// canned goods), "/literdrickklar" (per liter ready-to-drink, for
// concentrate), "/tvätt" (per wash, detergent), "/disk" (per dishwasher
// load), "/bukett" (per bouquet, flowers). A kg-drained-weight price and a
// kg-whole-weight price look identical if you only match on the "kg" prefix,
// but aren't actually comparable - so only the small set of plain,
// unqualified units below is normalized; everything else deliberately
// returns null rather than guess.
const UNIT_ALIASES = {
  kg: "kg",
  hg: "hg",
  g: "g",
  l: "l",
  lit: "l",
  liter: "l",
  st: "st",
  m: "m",
  meter: "m",
};

// Parses one comparison-price string into { minCents, maxCents, unit } (unit
// is one of UNIT_ALIASES' values), or null if the string doesn't carry a
// numeric value with an unambiguous, directly-comparable unit.
//
// A comparison price is frequently a *range* rather than a single value
// ("61:11-73:33/kg" - confirmed ~45-59% of all Coop/ICA comparison strings):
// this happens when one offer covers variable-weight/variable-size items (a
// "2 för 30 kr" deal on chips bags of 150-300 g gives a price-per-kg that
// genuinely spans a range). Both bounds are captured - min for ranking a
// deal's best case, max for its worst - and a single value yields min === max.
export function parseComparisonPrice(str) {
  if (!str) return null;

  // Coop trails every value with a period ("73,20/kg."); strip it before
  // doing anything else so it doesn't get parsed as part of the unit.
  let s = str.trim().replace(/\.$/, "");

  // ICA's beverage deposit suffix shows up as either "+ pant" or
  // "exkl(.) pant" ("18:94/liter + pant", "20:00/lit exkl pant") - both mean
  // the same thing (pant is a small fixed bottle deposit, quoted separately
  // from the product's own comparison price), so both are stripped the same
  // way rather than treated as two different, unrecognized units.
  s = s.replace(/\s*\+\s*pant$/i, "").replace(/\s*exkl\.?\s*pant$/i, "");

  // The unit always trails the last number in the string, including in a
  // range ("61:11-73:33/kg").
  const unitMatch = s.match(/\/\s*([a-zA-ZåäöÅÄÖ]+)\s*$/);
  const rawUnit = unitMatch?.[1]?.toLowerCase();
  const unit = rawUnit ? UNIT_ALIASES[rawUnit] : undefined;
  if (!unit) return null;

  // Every numeric token in the string - one for a single value, two for a
  // range. Swedish decimals use "," (Coop) or ":" (ICA/Willys).
  const tokens = s.match(/\d+(?:[.,:]\d+)?/g);
  if (!tokens) return null;
  const values = tokens
    .map((t) => Math.round(parseFloat(t.replace(":", ".").replace(",", ".")) * 100))
    .filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;

  return { minCents: Math.min(...values), maxCents: Math.max(...values), unit };
}

// Fallback for when the provider doesn't supply a comparison-price text at
// all (or it didn't parse - see the long tail of rejected units above): for
// a multi-buy deal, price_cents is the raw total for dealQuantity items
// (see e.g. products/willys/fetch.js's mapProduct for why it's never
// divided down on our own), so dividing here recovers a per-single-item
// price ("3 för 25,00" -> 8,33 kr/st) - a weaker normalization than a true
// per-kg/per-l price (it doesn't know the package's own weight or volume,
// just its count), but still a fair, directly-comparable number against
// another store's own per-st price, and better than leaving the deal
// entirely uncomparable. Only meaningful for an actual multi-buy - a
// single-item offer with no comparison price has nothing here to derive,
// so this deliberately returns null rather than echo price_cents back as
// if it were a real per-unit figure.
export function deriveComparisonFromDealQuantity(priceCents, dealQuantity) {
  if (priceCents == null || !Number.isInteger(dealQuantity) || dealQuantity < 2) return null;
  const cents = Math.round(priceCents / dealQuantity);
  return { minCents: cents, maxCents: cents, unit: "st" };
}

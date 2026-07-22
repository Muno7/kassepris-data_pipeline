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

// Parses one comparison-price string into { amountCents, unit } (unit is one
// of UNIT_ALIASES' values), or null if the string doesn't carry a numeric
// value with an unambiguous, directly-comparable unit.
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

  // The unit always trails the *last* number in the string, including in a
  // range ("61:11-73:33/kg") - pull it from the full string first, since
  // splitting on "-" for the lower bound (below) would otherwise strip it
  // whenever the unit only appears after the upper bound.
  const unitMatch = s.match(/\/\s*([a-zA-ZåäöÅÄÖ]+)\s*$/);
  const rawUnit = unitMatch?.[1]?.toLowerCase();
  const unit = rawUnit ? UNIT_ALIASES[rawUnit] : undefined;
  if (!unit) return null;

  // A range ("61:11-73:33/kg") reports its lower bound - the same documented
  // approximation parsePriceToCents uses for the main price, kept consistent
  // here rather than inventing a second convention.
  const firstOfRange = s.split(/[-–]/)[0];
  const match = firstOfRange.match(/(\d+(?:[.,:]\d+)?)/);
  if (!match) return null;

  const amount = parseFloat(match[1].replace(":", ".").replace(",", "."));
  if (!Number.isFinite(amount)) return null;

  return { amountCents: Math.round(amount * 100), unit };
}

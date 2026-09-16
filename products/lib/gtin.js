// GTIN identity helpers.
//
// The whole cross-chain model rests on the GTIN: ONE gtin = ONE products row,
// shared by every chain that sells it (see db/schema.sql). That only holds if
// every chain's string for the same barcode normalizes to the same key, and if
// codes that are NOT globally meaningful are recognised as such. Two things
// break it naively:
//
//   1. Padding. The same barcode legitimately appears as GTIN-8, UPC-A (12),
//      EAN-13 or GTIN-14 depending on who reports it - ICA's offer API gives
//      Nutella as "80177173" while Willys' image CDN files the same product
//      under "00000080177173". Compared as raw strings those are two
//      different products, and that is exactly what they became.
//   2. Restricted-circulation prefixes. GS1 reserves a slice of the number
//      space (EAN-13 02/04/2xx, UPC number systems 2 and 4, GTIN-8 prefixes
//      0 and 2) for codes a retailer mints in-house for weighed goods and
//      counter items. They carry correct check digits, so a checksum test
//      passes them, but they are not global identity: ICA's in-store bakery
//      mints a different one per store for the same cookie, and no other
//      chain can ever share one.

// GS1 mod-10 check digit. Weights alternate 3,1,3,1... counted from the digit
// immediately left of the check digit, which is what makes the test invariant
// to left zero-padding - the reason a GTIN can be compared at any width once
// it's padded to a common one.
export function hasValidCheckDigit(digits) {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const weight = (body.length - 1 - i) % 2 === 0 ? 3 : 1;
    sum += (body.charCodeAt(i) - 48) * weight;
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48;
}

// The number of digits a GTIN has once its leading zeros are removed - i.e.
// which GS1 format it really is (8/12/13/14), regardless of how the chain
// that reported it chose to pad. Prefix rules are defined per format, so
// classification has to work from this rather than the padded string.
function significantDigits(gtin) {
  return gtin.replace(/^0+/, "");
}

// Canonical storage form for a GTIN: left-zero-padded to 13, or to its own
// width when it's a genuine GTIN-14 case code. Returns null for anything that
// isn't a real GTIN, so callers can treat "no reliable gtin" uniformly.
//
// Padding to 13 rather than the GS1-canonical 14 is deliberate: ~99% of the
// catalogue is already EAN-13, so this leaves the overwhelming majority of
// rows byte-identical and confines the migration to the genuine outliers.
//
// The `< 8` significant-digit floor rejects both junk and the degenerate
// all-zero string (which passes the checksum). A GTIN-8 beginning with 0 has
// only 7 significant digits and is rejected with it - that prefix is
// restricted circulation anyway, so it was never usable as global identity.
export function normalizeGtin(raw) {
  if (raw == null) return null;
  const digits = String(raw).trim();
  if (!/^\d+$/.test(digits)) return null;

  const significant = significantDigits(digits);
  if (significant.length < 8 || significant.length > 14) return null;

  const canonical = significant.padStart(Math.max(13, significant.length), "0");
  return hasValidCheckDigit(canonical) ? canonical : null;
}

// True when the code is from a GS1 restricted-circulation range: a valid
// barcode, but one whose meaning is local to a retailer (often to a single
// store) rather than global. Such a code must never be treated as evidence
// that two chains are selling the same product, and two of them being
// different is not evidence that they are selling different products.
//
// Expects an already-normalized gtin; classification is by GS1 format, taken
// from the significant width, since the same prefix digits mean different
// things in a UPC than in an EAN-13.
export function isRestrictedCirculationGtin(gtin) {
  if (!gtin) return false;
  const significant = significantDigits(gtin);

  // GTIN-8: prefixes 0 and 2 are reserved for in-store use.
  if (significant.length <= 8) return /^[02]/.test(significant);

  // UPC-A: number system 2 (random-weight items) and 4 (retailer in-store).
  if (significant.length <= 12) return /^[24]/.test(significant);

  // EAN-13 / GTIN-14: GS1 prefixes 020-029 and 040-049 (in-store), and the
  // whole 200-299 block (restricted distribution).
  const prefix = significant.slice(significant.length - 13);
  return /^0[24]/.test(prefix) || /^2/.test(prefix);
}

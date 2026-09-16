// GTIN identity algorithm: canonicalization + restricted-circulation
// classification. These are the rules the whole cross-chain model rests on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasValidCheckDigit, normalizeGtin, isRestrictedCirculationGtin } from "../../products/lib/gtin.js";

test("normalizeGtin: same barcode at different widths -> one canonical key", () => {
  // Nutella GTIN-8 80177173 (valid check digit 3), padded to 13.
  const canonical = "0000080177173";
  assert.equal(normalizeGtin("80177173"), canonical); // ICA: bare GTIN-8
  assert.equal(normalizeGtin("0000080177173"), canonical); // already padded
  assert.equal(normalizeGtin("00000080177173"), canonical); // Willys: GTIN-14 from the CDN
  assert.equal(normalizeGtin("080177173"), canonical); // leading-zero-eaten UPC-style
});

test("normalizeGtin: canonical EAN-13 stays byte-identical (~99% of rows untouched)", () => {
  assert.equal(hasValidCheckDigit("7310865004703"), true);
  assert.equal(normalizeGtin("7310865004703"), "7310865004703");
});

test("normalizeGtin: rejects non-GTINs (junk, too short, bad check digit)", () => {
  assert.equal(normalizeGtin("15524"), null); // Coop composite catalog key (5 significant digits)
  assert.equal(normalizeGtin("abc"), null);
  assert.equal(normalizeGtin(""), null);
  assert.equal(normalizeGtin(null), null);
  assert.equal(normalizeGtin("0000000000000"), null); // all-zero passes the checksum but is junk
  assert.equal(normalizeGtin("7310865004700"), null); // wrong check digit
});

test("isRestrictedCirculationGtin: in-store/weighed codes are not global identity", () => {
  assert.equal(isRestrictedCirculationGtin("2320247200000"), true); // EAN-13 2xx (restricted)
  assert.equal(isRestrictedCirculationGtin("0240000000000"), true); // in-store (020-049 / UPC sys 2)
  assert.equal(isRestrictedCirculationGtin("0000080177173"), false); // ordinary GTIN-8 (prefix 8)
  assert.equal(isRestrictedCirculationGtin("7310865004703"), false); // ordinary EAN-13
});

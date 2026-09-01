// Pure-function unit tests: no DB, no network, run in milliseconds. These
// cover the parsing logic that breaks most often and most silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComparisonPrice, deriveComparisonFromDealQuantity } from "../../products/lib/comparisonPrice.js";
import { parsePriceToCents } from "../../products/lib/priceParsing.js";
import { buildFingerprint } from "../../products/lib/fingerprint.js";

test("comparisonPrice: single value -> min === max", () => {
  assert.deepEqual(parseComparisonPrice("73,20/kg."), { minCents: 7320, maxCents: 7320, unit: "kg" });
  assert.deepEqual(parseComparisonPrice("2,50/st"), { minCents: 250, maxCents: 250, unit: "st" });
});

test("comparisonPrice: range -> min < max (both bounds captured)", () => {
  assert.deepEqual(parseComparisonPrice("65,56-87,41/kg"), { minCents: 6556, maxCents: 8741, unit: "kg" });
  assert.deepEqual(parseComparisonPrice("61:11-73:33/kg"), { minCents: 6111, maxCents: 7333, unit: "kg" });
});

test("comparisonPrice: strips currency word and pant deposit", () => {
  assert.equal(parseComparisonPrice("16:66 kr/kg").minCents, 1666);
  assert.equal(parseComparisonPrice("18:94/liter + pant").unit, "l");
  assert.equal(parseComparisonPrice("20:00/lit exkl pant").minCents, 2000);
});

test("comparisonPrice: rejects non-comparable / empty units", () => {
  assert.equal(parseComparisonPrice("/kgutanspad"), null); // drained weight - not comparable
  assert.equal(parseComparisonPrice(""), null);
  assert.equal(parseComparisonPrice(null), null);
});

test("deriveComparisonFromDealQuantity: multi-buy -> per-item, single -> null", () => {
  assert.deepEqual(deriveComparisonFromDealQuantity(2500, 3), { minCents: 833, maxCents: 833, unit: "st" });
  assert.equal(deriveComparisonFromDealQuantity(2500, 1), null);
  assert.equal(deriveComparisonFromDealQuantity(null, 3), null);
});

test("parsePriceToCents: Swedish formats + range lower bound", () => {
  assert.equal(parsePriceToCents("79,90 kr"), 7990);
  assert.equal(parsePriceToCents("48,17-52,90"), 4817); // range -> lower bound
  assert.equal(parsePriceToCents("66,90/st"), 6690);
  assert.equal(parsePriceToCents(null), null);
});

test("fingerprint: stable, case/space-insensitive, marks nulls", () => {
  const a = buildFingerprint({ title: "Kaffe Bryggkaffe", size: "500 g", brand: "Zoégas" });
  const b = buildFingerprint({ title: "kaffe  bryggkaffe", size: "500g", brand: "zoégas" });
  assert.equal(a, b); // normalization collapses case + whitespace
  assert.notEqual(a, buildFingerprint({ title: "Te", size: null, brand: null }));
  assert.match(buildFingerprint({ x: null }), /NULL/);
});

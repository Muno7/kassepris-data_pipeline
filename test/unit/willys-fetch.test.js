import { test } from "node:test";
import assert from "node:assert/strict";
import { excludeEntriesWithoutVerifiedGtin } from "../../products/willys/fetch.js";

test("Willys fetch: unresolved GTIN rows are excluded without discarding the assortment", () => {
  const resolved = { product: { gtin: "7310865004703", title: "Resolved product" }, mainProductCode: "resolved" };
  const unresolved = { product: { gtin: null, title: "Unresolved product" }, mainProductCode: "unresolved" };

  const { products, skipped } = excludeEntriesWithoutVerifiedGtin([resolved, unresolved]);

  assert.deepEqual(products, [resolved.product]);
  assert.deepEqual(skipped, [unresolved]);
});

// Read-only Dabas verification against a small sample of globally comparable
// GTIN products already in the configured database. This deliberately lives outside test/integration:
// that suite drops/recreates its test schema, while this check is intended to
// inspect the database currently selected by DB_URL.
//
// Run: npm run test:dabas
// Optional: DABAS_TEST_SAMPLE_SIZE=10 npm run test:dabas
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { requireEnv } from "../products/lib/config.js";
import { normalizeGtin } from "../products/lib/gtin.js";

const DEFAULT_SAMPLE_SIZE = 5;

function sampleSize() {
  const raw = process.env.DABAS_TEST_SAMPLE_SIZE;
  if (raw == null) return DEFAULT_SAMPLE_SIZE;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 250) {
    throw new Error("DABAS_TEST_SAMPLE_SIZE must be an integer from 1 to 250");
  }
  return value;
}

function articleName(article) {
  return article.Produktnamn || article.Artikelbenamning || "(no product name returned)";
}

function productImageUrl(article) {
  // Do not substitute a retailer image or a Dabas thumbnail here: the base
  // PRODUCT_IMAGE is the supplier-published product image for this article.
  return article.Bilder?.find((image) => image.Informationstyp === "PRODUCT_IMAGE")?.Lank ?? null;
}

async function checkImage(url) {
  if (!url) return { status: null, contentType: null, detectedType: null, usable: false };
  const response = await fetch(url, {
    headers: { Range: "bytes=0-31" },
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type");
  const reader = response.body?.getReader();
  const { value = new Uint8Array() } = (await reader?.read()) ?? {};
  await reader?.cancel();
  const signature = [...value.slice(0, 12)];
  const detectedType =
    signature.slice(0, 3).join(",") === "255,216,255"
      ? "image/jpeg"
      : signature.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
        ? "image/png"
        : signature.slice(0, 4).join(",") === "71,73,70,56"
          ? "image/gif"
          : signature.slice(0, 4).join(",") === "82,73,70,70" && signature.slice(8, 12).join(",") === "87,69,66,80"
            ? "image/webp"
            : signature.slice(0, 4).join(",") === "73,73,42,0" || signature.slice(0, 4).join(",") === "77,77,0,42"
              ? "image/tiff"
              : null;
  return {
    status: response.status,
    contentType,
    detectedType,
    usable: response.ok && (contentType?.startsWith("image/") === true || detectedType != null),
  };
}

async function fetchDabasArticle(gtin, apiKey) {
  // Dabas indexes GTINs in their 14-digit representation. Kassepris stores
  // EAN-13 unchanged, so an EAN-13 needs one leading zero for this lookup.
  const dabasLookupGtin = String(gtin).padStart(14, "0");
  const url = new URL(
    `https://api.dabas.com/DABASService/V2/article/gtin/${encodeURIComponent(dabasLookupGtin)}/JSON`
  );
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Dabas returned HTTP ${response.status} for GTIN ${gtin}`);
  }
  return response.json();
}

describe("Dabas GTIN sample", () => {
  after(async () => {
    await pool.end();
  });

  it("returns the same canonical GTIN for each sampled database product", async () => {
    const apiKey = requireEnv("DABAS_API_KEY");
    const limit = sampleSize();
    const { rows: products } = await pool.query(
      `SELECT p.gtin, p.title, p.brand, p.size, c.slug AS category
       FROM products p
       JOIN product_groups pg ON pg.id = p.product_group_id
       JOIN categories c ON c.id = pg.category_id
       -- Dabas identifies globally published products. Restricted-circulation
       -- GTINs are retailer-local by definition and are not expected to exist
       -- in Dabas, so they are intentionally outside this verification.
       WHERE p.gtin IS NOT NULL AND NOT p.gtin_is_restricted
       -- A stable hash spreads the small sample across the catalogue without
       -- selecting only one recently imported retailer/category batch.
       ORDER BY md5(p.gtin)
       LIMIT $1`,
      [limit]
    );

    assert.ok(products.length > 0, "no GTIN products found in the configured database");

    const results = [];
    for (const product of products) {
      const article = await fetchDabasArticle(product.gtin, apiKey);
      const remoteGtin = article?.GTIN ?? null;
      const sameCanonicalGtin =
        article != null && normalizeGtin(product.gtin) === normalizeGtin(remoteGtin);
      const imageUrl = article ? productImageUrl(article) : null;
      const image = await checkImage(imageUrl);

      results.push({
        gtin: product.gtin,
        found: article != null,
        sameCanonicalGtin,
        category: product.category,
        databaseTitle: product.title,
        dabasTitle: article ? articleName(article) : "—",
        imageUrl,
        imageStatus: image.status,
        imageContentType: image.contentType,
        imageDetectedType: image.detectedType,
        usableImage: image.usable,
      });
    }

    const categorySummary = Object.values(
      Object.groupBy(results, (result) => result.category)
    ).map((group) => ({
      category: group[0].category,
      sampled: group.length,
      found: group.filter((result) => result.found).length,
      missing: group.filter((result) => !result.found).length,
      usableImages: group.filter((result) => result.usableImage).length,
    }));
    console.table(results.length > 20 ? results.slice(0, 20) : results);
    if (results.length > 20) console.log(`Showing 20 of ${results.length} sampled products.`);
    console.table(categorySummary.sort((a, b) => a.category.localeCompare(b.category)));

    const missing = results.filter((result) => !result.found);
    const mismatched = results.filter((result) => result.found && !result.sameCanonicalGtin);
    console.log(
      `Dabas coverage: ${results.length - missing.length}/${results.length} found; ` +
        `${mismatched.length} found response(s) had a different canonical GTIN.`
    );
    assert.equal(missing.length, 0, `${missing.length} sampled GTIN(s) were not found in Dabas`);
    assert.equal(mismatched.length, 0, `${mismatched.length} Dabas response(s) had a different GTIN`);
  });
});

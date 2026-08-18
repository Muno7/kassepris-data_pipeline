// The three Open-*-Facts sister databases used as licensed image sources,
// in fallback-tier order. Open Pet Food Facts exists too but nothing in
// this catalog is pet food, so it's not wired in. Wikidata (a fourth,
// name-matched rather than GTIN-matched tier) is deliberately not included -
// see the README for why.
//
// All three ship the same nightly bulk export (gzipped JSONL) at a
// predictable static URL, and all three are the same "Product Opener"
// software so the export schema and image URL convention are identical -
// see urls.js.
export const SOURCES = [
  {
    key: "off",
    label: "Open Food Facts",
    exportUrl: "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz",
    imageDomain: "images.openfoodfacts.org",
    license: "CC BY-SA 3.0",
  },
  {
    key: "opf",
    label: "Open Products Facts",
    exportUrl: "https://static.openproductsfacts.org/data/openproductsfacts-products.jsonl.gz",
    imageDomain: "images.openproductsfacts.org",
    license: "CC BY-SA 3.0",
  },
  {
    key: "obf",
    label: "Open Beauty Facts",
    exportUrl: "https://static.openbeautyfacts.org/data/openbeautyfacts-products.jsonl.gz",
    imageDomain: "images.openbeautyfacts.org",
    license: "CC BY-SA 3.0",
  },
];

export function exportPath(source) {
  return new URL(`exports/${source.key}.jsonl.gz`, import.meta.url).pathname;
}

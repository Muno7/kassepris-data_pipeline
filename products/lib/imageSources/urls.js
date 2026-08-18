// URL-building shared by every Open-*-Facts sister database (Open Food
// Facts, Open Products Facts, Open Beauty Facts) - same underlying "Product
// Opener" software, same path-sharding and filename convention for every
// one of them, confirmed against live API responses from each.

// Images are served from a path built by zero-padding the barcode to 13
// digits and splitting it into groups of 3/3/3/4 - e.g. code "40144382" ->
// path "000/004/014/4382". Confirmed against the bulk export's own `code`
// field, which is itself always stored zero-padded to 13 regardless of the
// barcode's real length (8-digit EAN-8 included).
export function buildImagePath(code) {
  const padded = code.padStart(13, "0");
  return `${padded.slice(0, 3)}/${padded.slice(3, 6)}/${padded.slice(6, 9)}/${padded.slice(9)}`;
}

export function buildImageUrl(domain, code, lang, rev, size = "400") {
  return `https://${domain}/images/products/${buildImagePath(code)}/front_${lang}.${rev}.${size}.jpg`;
}

const MIN_WIDTH = 200;
const MIN_HEIGHT = 200;
// Swedish first (these are Swedish grocery products), then English, then
// whatever's there - a product photo doesn't need translation to be usable.
const PREFERRED_LANGS = ["sv", "en"];

// `images` is the raw JSON value of the export's `images` column for one
// product. Only `selected.front.*` counts as a usable product photo - other
// keys (ingredients, nutrition, packaging, an unselected raw upload) are
// real uploads but not what a shopper needs to recognize the product on a
// deals page. Rejects anything under the minimum usable size outright
// rather than returning a thumbnail-quality image.
export function pickFrontImage(images) {
  const front = images?.selected?.front;
  if (!front || typeof front !== "object") return null;

  const langs = Object.keys(front);
  if (langs.length === 0) return null;
  const lang = PREFERRED_LANGS.find((l) => langs.includes(l)) ?? langs[0];
  const entry = front[lang];
  if (!entry?.rev) return null;

  const size400 = entry.sizes?.["400"];
  const full = entry.sizes?.full;
  const width = size400?.w ?? full?.w;
  const height = size400?.h ?? full?.h;
  if (!width || !height || width < MIN_WIDTH || height < MIN_HEIGHT) return null;

  return { lang, rev: entry.rev, width, height };
}

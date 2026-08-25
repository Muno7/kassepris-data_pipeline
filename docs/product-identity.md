# Product identity & comparability — problem statement

Captured from an earlier (discarded) attempt so the **problem** survives even
though that implementation didn't. The code for that attempt is archived on the
`backup/pre-split` branch; nothing here prescribes it — this is what we have to
solve, plus the facts and validated building blocks to solve it cleanly.

The image-licensing work that was tangled into the same attempt is now separate
(`feat/product-images`) and is out of scope here. Identity must not reach into
any image table.

---

## The core problem

The shipped model overloads one column, `products.gtin`, to mean three
different things, and gets each wrong. `gtin TEXT NOT NULL UNIQUE` storing the
raw retailer string:

### A. Same barcode, different widths → the same product becomes many rows
A GTIN legitimately appears as **GTIN-8, UPC-A (12), EAN-13, or GTIN-14**
depending on who reports it. Compared as raw strings, the same physical product
from two chains becomes two `products` rows — silently breaking the whole
premise ("one GTIN = one row, cross-chain, cheapest price is a plain join").
- **Evidence:** Nutella is `80177173` (GTIN-8) from ICA and `00000080177173`
  from Willys' image CDN. Coop offer `externalId` `"15524"` seen in real data.
- **Chain quirks found:** ICA is the only chain that was inserting *unvalidated*
  gtins (its `ean` field isn't guaranteed to be a real GTIN or a fixed width —
  bare GTIN-8, UPC-A at 12, UPC-A at 11 with the leading zero eaten). Willys'
  old extractor sliced exactly one leading zero (assumed every code was an
  EAN-13 padded by one), which mangled GTIN-8s. Coop's `externalId` is a real
  GTIN for some offers but a composite store+cluster+item catalog key wearing a
  gtin-shaped string for others — only the checksum tells them apart.

### B. No-GTIN products were dropped → real deals disappear
The current rule (strict `gtin NOT NULL`) skips any product with no recoverable
GTIN. Those are real, shoppable offers — **Coop alone: 53 products / 7,598
store-offers** vanishing from the app.
- **Decision (made):** keep them. A deal a shopper can walk into a store and buy
  is worth more than a tidy identity model. They get a **fallback identity** (as
  the pipeline had before this redesign), and are simply flagged not-comparable.

### C. "Has a GTIN" ≠ "is globally comparable"
~8% of barcodes are **GS1 restricted-circulation** codes — valid check digits,
but minted by a retailer in-house for weighed/counter goods, meaningful only
inside that retailer and often inside one store (ICA's in-store bakery mints a
different code per store for the same cookie).
- Treating any GTIN as global identity **falsely merges** unrelated products
  that share an in-store code, or **falsely compares** a store-local item across
  chains. `gtin IS NOT NULL` is the wrong comparability test.

---

## Requirements for the clean solution

1. **Canonical GTIN identity.** Every chain's string for the same barcode maps
   to one key. One canonical `products` row per real GTIN, cross-chain.
2. **Keep no-GTIN products** via a fallback identity (chain-scoped — a fallback
   key is only meaningful within the chain that produced it), visible in the app
   but not cross-chain comparable.
3. **Explicit comparability**, separate from identity: a product is comparable
   only when it has a real, globally-issued, **non-restricted** GTIN. Nothing in
   the app may gate comparison on a bare `gtin IS NOT NULL`.
4. **Exactly one identity per row**, enforced, so a bug can't insert a row
   identified by nothing and silently duplicate weekly.
5. **Safe live migration.** Canonicalizing existing gtins will collide
   padding-variants that must be **merged** (repoint `store_products`,
   `offer_products`, `historical_offer_products`; keep the oldest row + its
   group; delete losers + emptied groups). On RDS this must minimise locks and
   be idempotent/resumable.
6. **No coupling to images.** Identity code and migration must not touch
   `missing_images` or any `image_*` column (that was the previous seam that
   broke the migration).

---

## Validated building blocks (reusable — the algorithm was sound)

From the discarded attempt's `products/lib/gtin.js` (kept on `backup/pre-split`).
The logic is correct and GS1-accurate; reuse it, just wire it cleanly:

- `hasValidCheckDigit(digits)` — GS1 mod-10, weights 3,1,3,1… from the digit
  left of the check digit (so it's invariant to left zero-padding).
- `normalizeGtin(raw)` → canonical form or `null`:
  - digits only; strip leading zeros to get the **significant width** (true
    GS1 format 8/12/13/14, independent of how the chain padded).
  - reject significant length `< 8` or `> 14` (junk + the all-zero string that
    passes the checksum).
  - pad to `max(13, width)` — **13, not the GS1-canonical 14**, deliberately, so
    ~99% already-EAN-13 rows stay byte-identical and the migration touches only
    the genuine outliers.
  - require a valid check digit.
- `isRestrictedCirculationGtin(gtin)` — classify by significant width, since the
  same prefix means different things per format:
  - GTIN-8: prefixes `0`, `2`.
  - UPC-A (≤12): number systems `2` (random-weight) and `4` (in-store).
  - EAN-13/14: `020–029`, `040–049` (in-store) and the whole `2xx` block.

---

## Anti-patterns to avoid (why the previous attempt was "poor")

- **Bundling unrelated initiatives** (identity + image licensing) into one
  uncommitted, untested changeset — and coupling them (identity backfill wrote
  to the image `missing_images` table, so the migration failed against RDS).
- **Migration not self-contained / untested** against the real live-DB state.
- Letting the schema and the ingest/reader disagree on the comparability rule
  (keep it in exactly one place).

---

## Open design choices (to decide before implementing)

- **Fallback identity representation:** reuse the normalizer's attribute
  fingerprint (title/brand/size), chain-slug-prefixed. Column + partial unique
  index, vs. a single identity column with a discriminator. (Leaning: nullable
  `gtin` + `fingerprint`, exactly-one CHECK, both unique-where-present.)
- **Where comparability lives:** a generated/stored column vs. computed at read
  time. Generated keeps writer and reader from drifting, at the cost of a table
  rewrite on add (fine at ~17k rows).
- **Migration shape:** one idempotent, lock-aware script (canonicalize → merge
  → flag), decoupled from images, tested on the throwaway Docker Postgres first.

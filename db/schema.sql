CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name character varying NOT NULL,
  slug character varying NOT NULL UNIQUE
);

-- `assortment` and `stores.assortment_id` exist only for Willys, which (unlike
-- Coop/ICA) groups stores into shared "standard"/"hemma" newspaper
-- assortments rather than scraping each store individually. Still used by
-- the old Puppeteer-based stores/scripts/import_stores.js.
CREATE TABLE IF NOT EXISTS assortment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id uuid NOT NULL REFERENCES chain(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT unique_assortment_per_chain UNIQUE (chain_id, slug)
);

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id uuid NOT NULL REFERENCES chain(id),
  external_id text NOT NULL UNIQUE,
  name text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  address text,
  city text,
  latitude double precision,
  longitude double precision
);

-- Added after the table already existed in earlier runs of this schema, so
-- it needs an explicit ALTER (CREATE TABLE IF NOT EXISTS above is a no-op
-- once the table exists, it won't add new columns on its own).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS assortment_id uuid REFERENCES assortment(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_stores_chain_id ON stores (chain_id);
CREATE INDEX IF NOT EXISTS idx_stores_city ON stores (city);

-- Cross-chain product identity, keyed by the real barcode. A gtin identifies
-- one specific manufacturer packaging regardless of which chain sells it -
-- "Arla Ko Mellanmjölk 1,5L" carries the same gtin whether it's scraped from
-- Coop, ICA, or Willys - so this is what lets "cheapest price for this
-- product across my stores" be a plain indexed join instead of fuzzy
-- title/brand matching at read time. product rows stay chain-scoped (each
-- chain keeps its own title/image/copy - see product.canonical_product_id
-- below); this table is purely the identity anchor they link through.
--
-- Populated automatically by the link_canonical_product trigger defined
-- after the product table below, whenever a product row is written with a
-- gtin - never written directly by application code, so every current and
-- future importer (deals, Coop's catalog pipeline, an eventual ICA/Willys
-- catalog pipeline) gets this for free instead of duplicating the
-- upsert-and-link logic per importer.
--
-- Products without a gtin (all of Willys today; some Coop/ICA offers) have
-- no canonical_product and stay chain-siloed - matching those across chains
-- would need fuzzy text matching with no reliable ground truth, which is a
-- real limitation, not something this table tries to paper over.
CREATE TABLE IF NOT EXISTS canonical_product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gtin text NOT NULL UNIQUE,
  -- Best-known display fields for this physical product, filled in by
  -- whichever chain's importer reaches it first and left alone after (see
  -- link_canonical_product's COALESCE) - good enough for a search result or
  -- a generic product card; each chain's own product row is still the
  -- source of truth for how that chain individually presents it.
  title text,
  image text,
  brand text,
  size text,
  category_slug text,
  category_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- `gtin` is the product's real barcode (Coop: offer.externalId or
-- clusterInteriorOffers[].externalId, ICA: offer.eans[].id) - a far more
-- reliable identity than the text fingerprint, since it doesn't break on
-- formatting differences. Not every offer carries one, so `fingerprint` (the
-- old text-based identity) stays as a fallback. Identity for dedup/upsert
-- purposes is COALESCE(gtin, fingerprint), enforced below as an
-- expression-based unique index rather than a plain column constraint.
--
-- `variant_group` links sibling SKUs that were sold under one shared offer
-- (e.g. Coop's "Bryggkaffe" campaign covers several actual roasts/flavors,
-- each with its own gtin and its own product row here; ICA's eans[] work the
-- same way). Each variant is a real, independently queryable/comparable
-- product - not JSON nested inside a "parent" row - they just share this key
-- so the UI can still display them as one group. Null when an offer wasn't
-- part of any cluster.
CREATE TABLE IF NOT EXISTS product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id uuid NOT NULL REFERENCES chain(id) ON DELETE CASCADE,
  gtin text,
  fingerprint text NOT NULL,
  variant_group text,
  title text,
  image text,
  brand text,
  size text,
  more_info text,
  -- Normalized {slug, label, type} objects (see products/categories/badges.js)
  -- - not each chain's raw codes verbatim, so the app never needs per-chain
  -- switch statements to render them. Coop has no source data for these yet,
  -- so its products always have an empty array here - that's a real "no
  -- data" state, not a bug.
  badges jsonb,
  category_slug text,
  category_name text,
  raw_category_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dead column from when Willys nested sibling SKUs as JSON here - Willys now
-- uses variant_group + its own product rows like Coop/ICA, and never wrote
-- real data into this column even before that. Explicit DROP since the
-- table already existed without this happening via CREATE TABLE IF NOT EXISTS.
ALTER TABLE product DROP COLUMN IF EXISTS variants;

CREATE UNIQUE INDEX IF NOT EXISTS product_chain_identity_idx
  ON product (chain_id, COALESCE(gtin, fingerprint));
CREATE INDEX IF NOT EXISTS idx_product_chain_id ON product (chain_id);
CREATE INDEX IF NOT EXISTS idx_product_category_slug ON product (category_slug);
CREATE INDEX IF NOT EXISTS idx_product_gtin ON product (gtin);
CREATE INDEX IF NOT EXISTS idx_product_variant_group ON product (variant_group);

-- Added after the table already existed, so it needs an explicit ALTER (see
-- the `assortment_id` comment above for why). The cross-chain identity link
-- - see canonical_product above for what this is for.
ALTER TABLE product ADD COLUMN IF NOT EXISTS canonical_product_id uuid REFERENCES canonical_product(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_product_canonical_product_id ON product (canonical_product_id);

-- Keeps canonical_product_id in sync on every insert/update to product, so
-- no importer script (there are three today, and likely more later - see
-- canonical_product's comment) needs to remember to maintain this link
-- itself. Upserts canonical_product by gtin - COALESCE keeps whichever
-- display fields were filled in first rather than letting a later,
-- possibly sparser import overwrite them - then points NEW's
-- canonical_product_id at the result, or clears it back to null if this
-- row has no gtin (or had one and lost it).
CREATE OR REPLACE FUNCTION link_canonical_product() RETURNS trigger AS $$
BEGIN
  IF NEW.gtin IS NULL THEN
    NEW.canonical_product_id := NULL;
    RETURN NEW;
  END IF;

  INSERT INTO canonical_product (gtin, title, image, brand, size, category_slug, category_name)
  VALUES (NEW.gtin, NEW.title, NEW.image, NEW.brand, NEW.size, NEW.category_slug, NEW.category_name)
  ON CONFLICT (gtin) DO UPDATE SET
    title = COALESCE(canonical_product.title, EXCLUDED.title),
    image = COALESCE(canonical_product.image, EXCLUDED.image),
    brand = COALESCE(canonical_product.brand, EXCLUDED.brand),
    size = COALESCE(canonical_product.size, EXCLUDED.size),
    category_slug = COALESCE(canonical_product.category_slug, EXCLUDED.category_slug),
    category_name = COALESCE(canonical_product.category_name, EXCLUDED.category_name),
    updated_at = now()
  RETURNING id INTO NEW.canonical_product_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_link_canonical ON product;
CREATE TRIGGER product_link_canonical
  BEFORE INSERT OR UPDATE ON product
  FOR EACH ROW EXECUTE FUNCTION link_canonical_product();

-- Price, deal, and expiry are per-(store, product) facts, not per-product:
-- confirmed empirically that ~37% of ICA products carry a genuinely different
-- price across different stores in the same chain (Coop barely varies, ~0.3%,
-- since its prices are centrally set, but storing it here costs nothing extra
-- either way - same number of rows as before, just wider).
CREATE TABLE IF NOT EXISTS store_product (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  price_cents integer,
  unit text,
  comparison_price text,
  deal text,
  is_member boolean,
  valid_until timestamptz,
  PRIMARY KEY (store_id, product_id)
);

-- Added after the table already existed, so it needs an explicit ALTER (see
-- the `assortment_id` comment above for why). Amount saved vs. the regular
-- price, computed at fetch time from each chain's raw API data - null when
-- the chain's API doesn't expose a regular price (Coop never does; ICA and
-- Willys do).
ALTER TABLE store_product ADD COLUMN IF NOT EXISTS savings_cents integer;

-- price_cents is already the true single-sellable-unit price - multi-buy
-- deals ("3 för 25:-") are divided down to a per-item price at fetch time
-- (see products/willys/fetch.js and products/ica/fetch.js's
-- resolvePriceAndDeal) - but two single-item prices still aren't comparable
-- if the items are different sizes (1L milk vs 1,5L milk). These are the
-- actual per-kg/per-l/per-st price and its unit, parsed from each chain's
-- own "jämförpris" comparison-price text by products/lib/comparisonPrice.js.
-- This is the pair to compare when ranking "cheapest", not price_cents -
-- and only ever populated together: a numeric value paired with an
-- unrecognized/non-comparable unit (see that parser for the long tail of
-- ones it deliberately rejects, e.g. "kr/kg utan spad" for drained weight)
-- would be worse than no value at all, since it invites exactly the
-- apples-to-oranges comparison this column exists to prevent.
ALTER TABLE store_product ADD COLUMN IF NOT EXISTS comparison_price_cents integer;
ALTER TABLE store_product ADD COLUMN IF NOT EXISTS comparison_unit text;
ALTER TABLE store_product DROP CONSTRAINT IF EXISTS store_product_comparison_unit_check;
ALTER TABLE store_product ADD CONSTRAINT store_product_comparison_unit_check
  CHECK (comparison_unit IS NULL OR comparison_unit IN ('kg', 'hg', 'g', 'l', 'st', 'm'));

-- The resolved "N" behind a multi-buy deal (e.g. 3 for "3 för 25:-") -
-- price_cents above is already divided by this, so it's stored purely as an
-- audit trail for why a given price_cents is what it is ("why 8,33kr? -
-- 25,00/3"), not because anything downstream needs to redo the division.
ALTER TABLE store_product ADD COLUMN IF NOT EXISTS deal_quantity smallint;

CREATE INDEX IF NOT EXISTS idx_store_product_product_id ON store_product (product_id);

-- Regular/reference price from each chain's general online catalog - not
-- tied to a specific real store (unlike store_product), since these chains'
-- online catalogs serve one shared assortment/price list rather than a
-- per-store one. This is what lets us show savings on chains whose deal feed
-- never carries an original price (Coop), and gives every product a
-- ballpark price even when it isn't currently on deal anywhere - understood
-- to be an approximation that may differ slightly from any single physical
-- store's actual price.
CREATE TABLE IF NOT EXISTS product_online_price (
  product_id uuid PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
  price_cents integer,
  comparison_price text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Same normalized comparison price as store_product - see that table's
-- comment for why price_cents alone isn't safe to compare across products.
ALTER TABLE product_online_price ADD COLUMN IF NOT EXISTS comparison_price_cents integer;
ALTER TABLE product_online_price ADD COLUMN IF NOT EXISTS comparison_unit text;
ALTER TABLE product_online_price DROP CONSTRAINT IF EXISTS product_online_price_comparison_unit_check;
ALTER TABLE product_online_price ADD CONSTRAINT product_online_price_comparison_unit_check
  CHECK (comparison_unit IS NULL OR comparison_unit IN ('kg', 'hg', 'g', 'l', 'st', 'm'));

-- Append-only price log, one row per (store, product) whenever price_cents
-- actually changes (see products/update_db.js's price-history insert - it
-- checks the latest existing row first) - not written unconditionally on
-- every ingestion run, so this table's size tracks real price movement
-- instead of run frequency. This is what a real "lowest price in 6 months"
-- or trend view has to be built from: store_product only ever holds
-- current state (it's fully truncated and reloaded every run) and has no
-- memory of anything before "now". bigserial rather than uuid, unlike every
-- other table here, since this is a high-volume operational log with no
-- need for a globally-unique or client-generatable id, not a real entity
-- anything else references by id.
CREATE TABLE IF NOT EXISTS price_history (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  price_cents integer,
  comparison_price_cents integer,
  comparison_unit text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_recorded ON price_history (product_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_price_history_store_product_recorded ON price_history (store_id, product_id, recorded_at);

INSERT INTO chain (name, slug) VALUES ('Coop', 'coop') ON CONFLICT (slug) DO NOTHING;
INSERT INTO chain (name, slug) VALUES ('ICA', 'ica') ON CONFLICT (slug) DO NOTHING;
INSERT INTO chain (name, slug) VALUES ('Willys', 'willys') ON CONFLICT (slug) DO NOTHING;

-- Every real Willys store belongs to one of these two shared newspaper
-- assortments (confirmed: every store within each shares the exact same
-- product catalog) - slugs match products/willys/fetch.js's ASSORTMENTS.
INSERT INTO assortment (chain_id, slug, name)
  SELECT id, 'willys', 'Willys' FROM chain WHERE slug = 'willys'
  ON CONFLICT (chain_id, slug) DO NOTHING;
INSERT INTO assortment (chain_id, slug, name)
  SELECT id, 'willys-hemma', 'Willys Hemma' FROM chain WHERE slug = 'willys'
  ON CONFLICT (chain_id, slug) DO NOTHING;

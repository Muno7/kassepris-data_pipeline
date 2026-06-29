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

CREATE INDEX IF NOT EXISTS idx_store_product_product_id ON store_product (product_id);

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

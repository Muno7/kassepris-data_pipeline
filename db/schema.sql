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
  assortment_id uuid REFERENCES assortment(id) ON DELETE CASCADE,
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
  badges jsonb,
  category_slug text,
  category_name text,
  raw_category_name text,
  -- Willys's old normalizer still nests sibling SKUs as JSON here, unlike
  -- Coop/ICA which use variant_group + their own product rows now.
  variants jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

-- Documents the live "supermarket" database schema and adds the product tables.
-- Safe to run against the existing DB: chain/assortment/stores already exist and are left untouched.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name character varying NOT NULL,
  slug character varying NOT NULL UNIQUE
);

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
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Not populated by any scraper yet (raw store JSON only has code/name/url).
-- Columns added now so a future scraping pass can fill them without a migration.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS longitude double precision;

CREATE INDEX IF NOT EXISTS idx_stores_chain_id ON stores (chain_id);
CREATE INDEX IF NOT EXISTS idx_stores_city ON stores (city);

-- One row per unique product (deduplicated by fingerprint, same as the JSON normalizers).
CREATE TABLE IF NOT EXISTS product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id uuid NOT NULL REFERENCES chain(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  title text,
  image text,
  brand text,
  size text,
  price_cents integer,
  unit text,
  comparison_price text,
  deal text,
  is_member boolean,
  more_info text,
  badges jsonb,
  category_slug text,
  category_name text,
  raw_category_name text,
  variants jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_product_per_chain UNIQUE (chain_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_product_chain_id ON product (chain_id);
CREATE INDEX IF NOT EXISTS idx_product_category_slug ON product (category_slug);

-- Replaces the "stores": [...] array from the normalized JSON with a real many-to-many join.
CREATE TABLE IF NOT EXISTS store_product (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, product_id)
);

-- PK above covers "products at this store" lookups (store_id leads).
-- This covers the reverse direction: "which stores sell this product".
CREATE INDEX IF NOT EXISTS idx_store_product_product_id ON store_product (product_id);

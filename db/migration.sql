-- Migration: legacy Kassepris schema  ->  current db/schema.sql.
--
-- Legacy shape (chain, assortment, canonical_product, product, store_product,
-- price_history + rich stores) reshaped into the Kassepris domain model. Only
-- stores and chains are preserved - all product/offer/price data is dropped
-- and re-fetched from the retailer APIs (that data is disposable; the physical
-- store metadata and geo enrichment is not).
--
-- This file is ONLY the destructive/reshape half. It contains NO BEGIN/COMMIT
-- and does NOT create the new tables: db/migrate.js runs it and db/schema.sql
-- back-to-back inside a single transaction, so the new-table DDL lives in one
-- place (schema.sql) and the whole migration is atomic. Take a backup first
-- (db/migrate.js does, or `pg_dump "$DB_URL"`), then run `node db/migrate.js`.

-- 1. chain -> chains, keeping every id (stores.chain_id FKs stay valid). Add
--    the created_at/updated_at + UNIQUE(name) the target model wants; widen
--    the varchar columns to text.
ALTER TABLE chain RENAME TO chains;
ALTER TABLE chains RENAME CONSTRAINT chain_pkey TO chains_pkey;
ALTER TABLE chains RENAME CONSTRAINT chain_slug_key TO chains_slug_key;
ALTER TABLE chains ALTER COLUMN name TYPE text;
ALTER TABLE chains ALTER COLUMN slug TYPE text;
ALTER TABLE chains ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE chains ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE chains DROP CONSTRAINT IF EXISTS chains_name_key;
ALTER TABLE chains ADD CONSTRAINT chains_name_key UNIQUE (name);

-- 2. Drop the disposable data tables. stores.assortment_id must be dropped
--    before `assortment` (it FKs into it); CASCADE clears the FKs that
--    product/store_product/price_history point at each other and at stores.
--    The product_link_canonical trigger + its function are dropped with
--    `product` / explicitly.
DROP TABLE IF EXISTS price_history CASCADE;
DROP TABLE IF EXISTS store_product CASCADE;
DROP TABLE IF EXISTS product CASCADE;
DROP TABLE IF EXISTS canonical_product CASCADE;
DROP FUNCTION IF EXISTS link_canonical_product() CASCADE;
ALTER TABLE stores DROP COLUMN IF EXISTS assortment_id;
DROP TABLE IF EXISTS assortment CASCADE;

-- 3. Reshape `stores` to the target: external_id is only unique within a chain
--    (was a global UNIQUE), url becomes nullable, and the chain FK cascades.
--    All rich columns (address/city/latitude/longitude/url) are left intact.
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_external_id_key;
ALTER TABLE stores ALTER COLUMN url DROP NOT NULL;
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_chain_external_key;
ALTER TABLE stores ADD CONSTRAINT stores_chain_external_key UNIQUE (chain_id, external_id);
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_chain_id_fkey;
ALTER TABLE stores ADD CONSTRAINT stores_chain_id_fkey
  FOREIGN KEY (chain_id) REFERENCES chains(id) ON DELETE CASCADE;

-- db/schema.sql runs next (same transaction) to create categories,
-- product_groups, products, store_products, offers, offer_products,
-- historical_offers, historical_offer_products + seed categories.

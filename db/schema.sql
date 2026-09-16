-- Kassepris domain schema.
--
-- Kassepris is a weekly supermarket-deal aggregator: it does NOT hold a full
-- supermarket assortment, only the products that appear in weekly offers, at
-- the specific physical stores a user has selected. Every retailer (Coop, ICA,
-- Willys) is normalized into this one shared model - there are deliberately no
-- retailer-specific tables (no ica_products/coop_offers/...). Which chain a row
-- came from is expressed only through stores.chain_id.
--
-- Core identity rules:
--   * A GTIN (real barcode) is the global identity of a physical product.
--     ONE gtin  = ONE products row, shared across every chain that sells it.
--   * A product belongs to exactly one product_group (the user-facing "one
--     search result" entity, e.g. "Kryddiga korvar"), which carries the
--     category. A group holds one or many gtin products (mix-and-match
--     campaigns expose several variant SKUs under one group).
--   * offers holds ONLY the current active weekly dataset (what the app
--     queries). historical_offers holds past cycles and is not on the MVP
--     read path. products / product_groups are persistent and never archived.
--
-- This file is idempotent (CREATE ... IF NOT EXISTS) and is the canonical
-- schema. To migrate an already-populated legacy database (chain/product/
-- store_product/...) into this shape, run db/migration.sql instead - it
-- preserves stores + chains and rebuilds the rest.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram search on product titles

-- ---------------------------------------------------------------------------
-- chains: supermarket chains/retailers (ICA, Coop, Willys).
-- ---------------------------------------------------------------------------
-- `slug` is not in the abstract target model but is kept because the entire
-- ingestion pipeline identifies a chain by a stable lowercase slug ('coop',
-- 'ica', 'willys') rather than its display name - it's a required operational
-- key, not stored API data.
CREATE TABLE IF NOT EXISTS chains (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- stores: one specific physical supermarket location - the canonical source
-- of truth for physical-store metadata (address, geo, retailer page URL),
-- kept rich to support store selection / filtering / nearby / distance sort.
-- ---------------------------------------------------------------------------
-- external_id is the retailer's own id for the physical store (ICA BMSStoreId,
-- Coop storeLedgerAccountNumber, Willys store code). It's only unique WITHIN a
-- chain, hence UNIQUE(chain_id, external_id) rather than a global unique - and
-- never used as the primary key.
CREATE TABLE IF NOT EXISTS stores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id    uuid NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name        text NOT NULL,
  address     text,
  city        text,
  latitude    double precision,
  longitude   double precision,
  url         text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_chain_external_key UNIQUE (chain_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_stores_chain_id ON stores (chain_id);
CREATE INDEX IF NOT EXISTS idx_stores_city ON stores (city);

-- ---------------------------------------------------------------------------
-- categories: Kassepris's own normalized category taxonomy. Every retailer
-- maps its raw category names into one of these (see products/categories/
-- displayCategories.js) - the app never sees a raw retailer category.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- product_groups: the user-facing conceptual product/deal - the unit of "one
-- search result". NOT a GTIN. Holds one or many gtin products; a mix-and-match
-- campaign ("3 för 59 kr" over chorizo/grillkorv/bratwurst) is one group with
-- several products. The category lives here, not on products.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category_id uuid NOT NULL REFERENCES categories(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_groups_category_id ON product_groups (category_id);

-- ---------------------------------------------------------------------------
-- products: one exact physical product/SKU. Persistent and canonical - never
-- archived, never duplicated per chain. When several chains describe the same
-- gtin differently, the display fields hold one normalized version (first
-- non-null wins at ingest time).
-- ---------------------------------------------------------------------------
-- Identity is a canonical GTIN, OR a chain-scoped fingerprint fallback. See
-- products/lib/gtin.js and docs/product-identity.md.
--
--   * gtin - TEXT, never an integer (leading zeros / width matter). Stored in
--     the canonical zero-padded form so the same barcode reported at different
--     widths by different chains (ICA GTIN-8, Willys GTIN-14, ...) is ONE row.
--     NULL when the pipeline found no real GTIN.
--   * fingerprint - the fallback identity for a no-GTIN product: the
--     normalizer's stable title/brand/size hash, prefixed with the chain slug
--     because it is only meaningful within the chain that produced it. Such a
--     product still reaches the app with all its offers; it just isn't
--     cross-chain comparable.
--   * products_identity_check + the two partial unique indexes: exactly one of
--     gtin/fingerprint is set, and each is unique where present, so a bug can't
--     insert a row identified by nothing and silently duplicate weekly.
--   * gtin_is_restricted - a valid GTIN from a GS1 restricted-circulation range
--     (in-store/weighed goods; ICA's bakery mints one per store). Valid barcode,
--     but NOT global identity - two chains can never share one. ~8% of catalogue.
--   * is_comparable - GENERATED, the ONE comparability rule (writer and reader
--     can't drift): only a real, non-restricted GTIN. The app must gate
--     cross-chain comparison on this, never on a bare `gtin IS NOT NULL`.
CREATE TABLE IF NOT EXISTS products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_group_id   uuid NOT NULL REFERENCES product_groups(id),
  gtin               text,
  fingerprint        text,
  gtin_is_restricted boolean NOT NULL DEFAULT false,
  is_comparable      boolean GENERATED ALWAYS AS (gtin IS NOT NULL AND NOT gtin_is_restricted) STORED,
  title              text NOT NULL,
  brand              text,
  size               text,
  image_url          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_identity_check CHECK ((gtin IS NOT NULL) <> (fingerprint IS NOT NULL))
);
-- Partial so the many gtin'd rows (fingerprint NULL) stay out of the fingerprint
-- index entirely, and vice-versa.
CREATE UNIQUE INDEX IF NOT EXISTS products_gtin_key ON products (gtin) WHERE gtin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_fingerprint_key ON products (fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_product_group_id ON products (product_group_id);
CREATE INDEX IF NOT EXISTS idx_products_title_lower_trgm ON products USING gin (lower(title) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- store_products: persistent many-to-many between physical stores and gtin
-- products. Records that Kassepris has *observed* this product at this store
-- through its data sources - NOT a claim of full assortment, and NOT deleted
-- just because the product isn't on deal this week (first_seen/last_seen track
-- the observation window instead).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_products (
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_store_products_product_store ON store_products (product_id, store_id);

-- ---------------------------------------------------------------------------
-- offers: CURRENT weekly offers only - the operational dataset the app reads.
-- One offer belongs to one physical store and applies to one OR many products
-- (mix-and-match), so eligible products live in offer_products, never as a
-- product_id column here. Money is integer öre, never floating point.
-- ---------------------------------------------------------------------------
-- Business rule enforced by the ingestion layer (not a DB constraint, since a
-- product is related through offer_products, not directly): the same product
-- must not appear in two simultaneously-active current offers at one store.
-- comparison_price_min_cents / max_cents are the per-unit ("jämförpris") price
-- range for the offer: equal for a fixed-size product, a real min<max range
-- when the offer covers variable-weight/size items (a "2 för 30 kr" deal on
-- 150-300 g chips bags spans a price-per-kg range) - so ranking by "cheapest
-- per unit" can use min, and the worst case is still visible via max.
-- valid_from is the offer's real start when the retailer provides one, else
-- ingestion time, always clamped to <= now() so a live offer is never hidden
-- behind a future start date (see products/update_db.js).
CREATE TABLE IF NOT EXISTS offers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  price_cents                integer NOT NULL,
  original_price_cents       integer,
  is_member                  boolean NOT NULL DEFAULT false,
  deal_quantity              integer,
  unit                       text,
  comparison_price_min_cents integer,
  comparison_price_max_cents integer,
  comparison_unit            text,
  deal_text                  text,
  more_info                  text,
  valid_from                 timestamptz NOT NULL,
  valid_until                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offers_store_id ON offers (store_id);
CREATE INDEX IF NOT EXISTS idx_offers_valid ON offers (valid_from, valid_until);

-- offer_products: eligible products for a current offer (mix-and-match).
CREATE TABLE IF NOT EXISTS offer_products (
  offer_id   uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (offer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_offer_products_product_offer ON offer_products (product_id, offer_id);

-- ---------------------------------------------------------------------------
-- historical_offers: offers from previous weekly cycles, archived verbatim
-- from `offers` when a store's/chain's current offers are replaced. Completely
-- separate from the current dataset and not on the MVP read path (kept for
-- future price history / analytics). Preserves the offer's exact state at the
-- time it was active.
-- ---------------------------------------------------------------------------
-- original_offer_id is the id the row had in `offers`, kept for traceability
-- only - deliberately NOT a foreign key, so archiving must never be blocked by
-- (or cascade from) the current offer being deleted right after.
CREATE TABLE IF NOT EXISTS historical_offers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_offer_id          uuid,
  store_id                   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  price_cents                integer NOT NULL,
  original_price_cents       integer,
  is_member                  boolean NOT NULL DEFAULT false,
  deal_quantity              integer,
  unit                       text,
  comparison_price_min_cents integer,
  comparison_price_max_cents integer,
  comparison_unit            text,
  deal_text                  text,
  more_info                  text,
  valid_from                 timestamptz NOT NULL,
  valid_until                timestamptz NOT NULL,
  archived_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historical_offers_store_id ON historical_offers (store_id);
CREATE INDEX IF NOT EXISTS idx_historical_offers_valid ON historical_offers (valid_from, valid_until);

-- historical_offer_products: frozen product eligibility of each past offer -
-- which exact gtins were part of that historical mix-and-match, even if the
-- product's group later changes (products persist; this stays as it was).
CREATE TABLE IF NOT EXISTS historical_offer_products (
  historical_offer_id uuid NOT NULL REFERENCES historical_offers(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (historical_offer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_historical_offer_products_product ON historical_offer_products (product_id, historical_offer_id);

-- ---------------------------------------------------------------------------
-- Seed data.
-- ---------------------------------------------------------------------------
INSERT INTO chains (name, slug) VALUES
  ('Coop',   'coop'),
  ('ICA',    'ica'),
  ('Willys', 'willys')
ON CONFLICT (slug) DO NOTHING;

-- Kassepris's normalized categories - kept in sync with the keys/names in
-- products/categories/displayCategories.js. Slugs are the frontend-safe id.
INSERT INTO categories (slug, name) VALUES
  ('fresh_food',           'Färskvaror'),
  ('fruit_and_vegetables', 'Frukt & grönt'),
  ('dairy_and_eggs',       'Mejeri & ägg'),
  ('bread_and_bakery',     'Bröd & bageri'),
  ('frozen_food',          'Fryst'),
  ('pantry',               'Skafferi'),
  ('snacks_and_sweets',    'Godis & snacks'),
  ('drinks',               'Dryck'),
  ('home_and_leisure',     'Hem & fritid'),
  ('health_and_beauty',    'Hälsa & skönhet'),
  ('other',                'Övrigt')
ON CONFLICT (slug) DO NOTHING;

#!/usr/bin/env bash
# Recurring job: fetches current product offers for Coop, ICA, and Willys,
# normalizes them, and reloads the current-offer side of the schema (products,
# product_groups, store_products, offers, offer_products) - archiving the
# previous cycle's offers into the historical_* tables per chain. Assumes
# scripts/init-db.sh (or db:migrate) has already been run at least once (schema
# + stores in place) - this script never touches the stores table.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== 1/4: Fetching + normalizing Coop/ICA products ==="
npm run products:fetch

echo "=== 2/4: Fetching Willys products ==="
npm run products:willys:fetch

echo "=== 3/4: Normalizing Willys products ==="
npm run products:willys:normalize

echo "=== 4/4: Importing all products into DB ==="
npm run products:update-db

echo "=== Product update complete ==="

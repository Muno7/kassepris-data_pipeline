#!/usr/bin/env bash
# One-time (or per-environment) setup: creates the schema and loads store
# data. Stores rarely change, so this is meant to be run once per deployment/
# machine, not on a recurring schedule - see scripts/update-products.sh for
# the part that does run regularly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

set -a
source .env
set +a

echo "=== 1/5: Applying schema ==="
psql "$DB_URL" -f db/schema.sql

echo "=== 2/5: Fetching Coop + ICA stores ==="
npm run stores:fetch

echo "=== 3/5: Upserting Coop + ICA stores into DB ==="
npm run stores:update-db

echo "=== 4/5: Importing Willys stores into DB ==="
npm run stores:willys:update-db

echo "=== 5/5: Enriching Willys store locations ==="
npm run stores:willys:enrich-locations

echo "=== DB init complete ==="

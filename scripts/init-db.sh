#!/usr/bin/env bash
# One-time (or per-environment) setup: creates the schema and loads store
# data. Stores rarely change, so this is meant to be run once per deployment/
# machine, not on a recurring schedule - see scripts/update-products.sh for
# the part that does run regularly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Load .env when present (local host). In containers there's no .env file - the
# environment is injected at runtime (compose env_file / -e) - so this is
# optional, not required.
# An explicitly selected environment (notably APP_ENV=test in the production
# E2E suite) must win over a host .env file. Containers do not have .env, but
# this also makes host setup predictable when a caller supplies its own DB_URL.
if [ -f .env ] && [ -z "${APP_ENV:-}" ]; then
  set -a
  source .env
  set +a
fi

echo "=== 1/5: Applying schema ==="
npm run db:schema   # node-native (no psql needed), so this runs in-container too

echo "=== 2/5: Fetching Coop + ICA stores ==="
npm run stores:fetch

echo "=== 3/5: Upserting Coop + ICA stores into DB ==="
npm run stores:update-db

echo "=== 4/5: Importing Willys stores into DB ==="
npm run stores:willys:update-db

echo "=== 5/5: Enriching Willys store locations ==="
npm run stores:willys:enrich-locations

echo "=== DB init complete ==="

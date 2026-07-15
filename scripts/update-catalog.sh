#!/usr/bin/env bash
# General-catalog job, separate from scripts/update-products.sh's weekly
# deals cycle - this refreshes each chain's full online assortment/reference
# price (product_online_price), which changes far less often than deals do.
# Coop-only for now; ICA and Willys will get their own catalog fetchers
# added here later.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== 1/3: Fetching Coop catalog ==="
npm run products:coop:catalog:fetch

echo "=== 2/3: Normalizing Coop catalog ==="
npm run products:coop:catalog:normalize

echo "=== 3/3: Importing Coop catalog into DB ==="
npm run products:coop:catalog:update-db

echo "=== Catalog update complete ==="

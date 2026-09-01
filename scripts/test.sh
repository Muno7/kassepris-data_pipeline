#!/usr/bin/env bash
# Full test workflow, run after each change:
#   1. unit tests  - pure functions, no DB/network, milliseconds
#   2. integration - the real pipeline on a small sample (a few seeded stores,
#      fetched live) into the disposable test Postgres, asserting the structural
#      invariants. ~10-20s, mostly ICA's rate-limited sample fetch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export APP_ENV=test

echo "=== unit tests ==="
node --test test/unit/*.test.js

echo "=== ensuring disposable test Postgres is up (docker compose db) ==="
docker compose up -d db >/dev/null
cid="$(docker compose ps -q db)"
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = "healthy" ] && break
  sleep 1
done

echo "=== integration test (sample live fetch -> ingest) ==="
node --test test/integration/*.test.js

echo "=== all tests passed ==="

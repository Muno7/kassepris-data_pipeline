#!/usr/bin/env bash
# Explicit, long-running production-shaped verification. It builds the Docker
# image from this checkout and updates a dedicated persistent local database on
# port 5434. If you manually reset that database, the test bootstraps it first;
# otherwise it runs the update-only production path. It never targets the host
# development or production database.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

export APP_ENV=test
export DB_URL=postgresql://kassepris:kassepris@localhost:5434/kassepris_production_test

compose=(docker compose -p kassepris-production-test -f docker-compose.yml -f docker-compose.production-test.yml)
"${compose[@]}" build app
"${compose[@]}" up -d db >/dev/null

cid="$("${compose[@]}" ps -q db)"
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = "healthy" ] && break
  sleep 1
done

RUN_PRODUCTION_E2E=1 node --test test/e2e/production-e2e.test.js

# Development and operations

[Documentation home](../README.md) · [Architecture](architecture.md) · [Deployment](../deploy/README.md)

## Configuration

Normal Node entrypoints select a profile using the **already-exported** `APP_ENV`, then `NODE_ENV`, then `development`. They load `.env.<profile>` first and `.env` second; existing process variables win over both files. Setting `APP_ENV` only inside `.env` does not choose the profile before loading begins.

**Exception:** host `npm run db:init` sources `.env` with Bash before starting Node. That can overwrite an inline/exported `DB_URL` or `APP_ENV`. Prefer initialization through Compose, where the image excludes `.env` and Compose injects the settings. Other npm scripts do not perform this shell source step.

| Variable | Effective default / use |
| --- | --- |
| `APP_ENV` | `development` unless exported `NODE_ENV` supplies another profile |
| `DB_URL` | PostgreSQL connection string; explicitly configure it |
| `DB_SSL` | `true` in production, otherwise `false`, unless explicitly set; production does **not** force it on |
| `DB_SSL_REJECT_UNAUTHORIZED` | `false`; certificate verification when SSL is enabled. No explicit CA-bundle option is wired in the pool |
| `COOP_PRODUCTS_SUBSCRIPTION_KEY` | Required by Coop product fetch |
| `COOP_STORE_INFO_SUBSCRIPTION_KEY` | Required by Coop product fetch for store mapping |
| `PIPELINE_DATA_ROOT` | Product artifact root, default `products/`; export before launching |
| `LOG_LEVEL` | `info`; scoped logger threshold (`debug`, `info`, `warn`, `error`); direct console output is separate |

### Product fetch tuning

These are source defaults, not newly measured retailer policies. Explicit ECS settings supply production Willys pacing; `APP_ENV=production` alone does not change these fetcher defaults.

| Variable suffix (prefix with chain) | `COOP_` | `ICA_` | `WILLYS_` |
| --- | --- | --- | --- |
| `FETCH_CONCURRENCY` | 10 | 3 | 6 |
| `FETCH_MAX_RETRIES` | 4 | 4 | 4 |
| `FETCH_STORE_RETRY_PASSES` | 2 | 2 | Not used |
| `FETCH_MIN_DELAY_MS` | 0 | 850 | 0 |

`WILLYS_GTIN_FALLBACK_CONCURRENCY` defaults to 3. The ECS template sets Willys delay to `10000` and concurrency to `1`; ICA remains `850`. Shared HTTP handling can also pace from response headers. Store discovery has separate tuning. Integer configuration uses `parseInt` without strict whole-string or positive-range validation.

## Local setup and commands

Follow the [README quick start](../README.md#first-local-run) for `.env`, dependencies, and Compose initialization. Ordinary ingestion needs no browser. Rebuild `app` after source changes: Compose does not bind-mount the checkout into the container.

| Command | What it actually does |
| --- | --- |
| `npm run db:schema` | Apply fresh schema/seeds, without store fetching or migration of incompatible existing columns |
| `npm run db:init` | Schema plus all-chain store setup; host `.env` sourcing caveat above |
| `npm run stores:fetch` | Coop/ICA discovery to JSON only |
| `npm run stores:update-db` | Coop/ICA JSON upsert |
| `npm run stores:willys:update-db` | Import committed Willys stores |
| `npm run stores:willys:enrich-locations` | Fill Willys rows missing latitude |
| `npm run products:fetch` | Coop/ICA fetch and normalize; needs DB store selection |
| `npm run products:willys:fetch` | Both Willys assortments; canonicalizes GTINs recovered from Axfood image URLs |
| `npm run products:willys:normalize` | Normalize existing Willys raw files |
| `npm run products:update-db` | Import every available chain file; replace/discard prior current offers |
| `npm run products:update-all` | Full recurring pipeline, all three chains |
| `npm run test:production-e2e` | Build the image and run a full, two-pass refresh against the persistent production-like local DB on port 5434 |
| `npm run test:production-e2e:reset` | Explicitly delete only that production-like test DB volume before a fresh bootstrap |

To execute in the app container, prepend `docker compose run --rm app`:

```bash
docker compose run --rm app npm run db:schema
```

Separate `--rm` containers **do not share generated product files**. Fetch, normalize, and import must run in one container (as `products:update-all` does) or use an explicitly shared artifact volume. The database volume persists.

For focused host work against disposable Compose PostgreSQL:

```bash
docker compose up -d db
export APP_ENV=test
export DB_SSL=false
export DB_URL=postgresql://kassepris:kassepris@localhost:5433/kassepris_test
npm run db:schema
# Populate stores separately through setup or the integration fixtures.
```

To re-normalize existing Coop/ICA files without refetching, call their exported functions. Simply running those normalizer files does nothing:

```bash
node --input-type=module -e "import { normalizeAllCoopStores } from './products/coop/normalize.js'; normalizeAllCoopStores();"
node --input-type=module -e "import { normalizeAllIcaStores } from './products/ica/normalize.js'; normalizeAllIcaStores();"
```

The importer has no chain-selection argument. Before a partial import, check all normalized files present in the selected artifact root. An empty array clears that chain's current offers; a missing file preserves them.

## Tests

### Offline units

```bash
npm run test:unit
```

Node's built-in runner tests price/comparison parsing, fingerprints, and GTIN helpers. **11 tests passed** during this documentation review. These tests do not load every retailer entrypoint or verify database schema compatibility.

### Live integration sample

Integration **drops and recreates the entire `public` schema**. Verify an explicitly disposable database: the helper only guards with a URL regex matching `kassepris_test` or `:5433`, not an independent check of server ownership or data value.

```bash
APP_ENV=test DB_SSL=false \
DB_URL=postgresql://kassepris:kassepris@localhost:5433/kassepris_test \
npm test
```

`npm test` runs units, starts/waits for Compose PostgreSQL, then integration. With the DB already running, use the same environment and `npm run test:integration`; that command does not start PostgreSQL. Both need live retailer access and Coop keys. `APP_ENV=test` alone can still fall back to `.env`'s DB URL.

The harness seeds six stores, uses temporary product artifacts, executes real fetch/normalize/import steps, then imports again to check replacement. Assertions cover aggregate ingestion, one offer per product/store, comparison ranges, dates, mix-and-match, selected references, stable GTIN product IDs, and current-offer counts. They do not require successful output from every chain. Assumptions that the live sample contains a price range and a multi-product deal can fail as offers change.

Temporary product artifacts are removed afterward; the test DB remains. Willys rows whose GTIN cannot be recovered are logged and skipped, rather than failing the refresh. No live integration run was performed for this documentation change.

### Production-shaped refresh acceptance test

```bash
npm run test:production-e2e
```

This is the pre-release test for the image that will run on AWS. It builds the
checkout's Docker image, connects it to the persistent local Compose project
`kassepris-production-test`, and uses only
`kassepris_production_test` on host port **5434**. It never resets that
database: on the first run after an explicit reset it performs `db:init` plus a
full refresh; thereafter it performs the normal update-only path. Reset it
only when desired:

```bash
npm run test:production-e2e:reset
```

The acceptance test validates the database before and after a second,
new-container refresh. It requires all three chains to have stores, offers,
and product links; validates canonical GTINs, positive prices, valid offer date
ranges, and offer/product links; proves a GTIN can retrieve its current
offers; preserves `GTIN -> product UUID`; and verifies the history table is
absent. For each retailer it also requires the second refresh to retain at
least **95%** of the first refresh's offers, offered products, offer-product
links, and stores with offers. This deliberately detects partial retailer
fetches that a simple nonzero-count smoke test misses. A legitimate weekly
change exceeding that threshold needs investigation and an intentional
threshold adjustment, not a blind release.

### Full local smoke run

```bash
make build
make test
```

`make test` initializes all stores and runs the full live pipeline in Compose using `APP_ENV=development`, then checks row counts. It is broader than the sample test and does not run unit assertions. Willys rows without a verified GTIN are reported and skipped. Compose's app image is fixed at `kassepris-scraper:latest`, independently of custom Make image tags.

`make test-down` calls `docker compose down -v` and deletes the disposable DB volume. `docker compose down` preserves that volume.

## Inspecting results

Check per-chain failed fetches, normalization errors, skipped GTINs, unmatched store keys, and removed/inserted counts. Compare with a known healthy run. Overall nonzero totals can conceal a missing chain.

Use this read-only query in a database client:

```sql
SELECT c.slug,
       count(DISTINCT s.id) AS stores,
       count(o.id) AS offers,
       count(o.id) FILTER (WHERE o.valid_until < now()) AS expired_offers
FROM chains c
LEFT JOIN stores s ON s.chain_id = c.id
LEFT JOIN offers o ON o.store_id = s.id
GROUP BY c.slug
ORDER BY c.slug;
```

`make test-psql` provides overall product/offer/store counts for Compose. Persistent product and store counts can remain high despite reduced current offers.

## Troubleshooting

| Symptom | Check next |
| --- | --- |
| Willys GTIN missing from a campaign product | The row is skipped and counted as a validation failure; inspect its logged product code and the catalog recovery summary. Ordinary cards use exact product codes; mix-and-match cards use exact promotion-code expansion. |
| Coop authorization/missing variable | Both key names, exported settings, active dotenv profile |
| DB/TLS error | Host `localhost:5433` vs container `db:5432`, URL/profile, SSL; host `db:init` override behavior |
| Empty Coop/ICA output | Store table population/URLs, fetch summaries, upstream shape |
| Products missing after normalization | Category maps, error totals, GTINs, first-offer deduplication |
| Reduced offers after import | Empty/partial normalized files, skipped GTIN/categories, unmatched stores |
| Old offers reappear | Leftover raw files, cache, normalized timestamps, expired validity; no run-specific manifest |
| Resume starts fresh in a new container | Runtime state is ephemeral and not mounted |
| Shape warning | Compare raw response with baseline; sampled optional fields can cause noise |
| Unit pass but integration failure | Full entrypoint loading, DB/network/keys, live-data assumptions |
| Container ignores source edit | Rebuild; no source bind mount is configured |

An import retry adds another historical snapshot. Retain diagnostic logs/raw data before rerunning; a fresh `PIPELINE_DATA_ROOT` can isolate artifacts without mixing old files. There is no built-in production data rollback command.

## Future CI/CD starting point

No automation is added by this documentation change. A later workflow can use these existing seams:

1. Locked dependency install without Chromium, then offline unit tests.
2. Resolve entrypoint/identity gaps and add appropriate behavioral coverage.
3. Integration against explicitly disposable PostgreSQL, with live retailer availability distinguished from offline correctness.
4. Build and test the exact image for the task's architecture.
5. Push a unique image tag, render a matching task definition, register a revision, and observe a run before updating the schedule.

Before unattended refreshes, define coverage thresholds, fresh-snapshot handling, overlapping-run behavior, and failure alerts. These controls are not currently implemented by the shell's `set -e`.

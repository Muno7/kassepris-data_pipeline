# Repository map

[Documentation home](../README.md) · [Architecture](architecture.md) · [Operations](development.md)

Paths below are relative to the repository root. Generated data and `node_modules` are not source. Read the smallest relevant set using the task index, then follow imports when needed.

## Task index

| Task | Start with |
| --- | --- |
| Missing retailer offers or changed API/HTML | Retailer `products/<chain>/fetch.js`, then `httpClient.js`, logs/raw output |
| Wrong price, quantity, dates, category, badge | Retailer fetch + normalize; shared parsing/category modules |
| Duplicate/missing products or wrong comparison eligibility | `gtin.js`, normalizer deduplication, `products/update_db.js`, schema, identity document |
| Missing store or wrong coordinates | `stores/<chain>/...`, store importer, Willys enrichment |
| Wrong current/history data | `products/update_db.js`, SQL schema, integration tests |
| Configuration issue | `config/env.js`, `db/pool.js`, `products/lib/config.js`, invoking shell script |
| Container/manual release or future CI/CD | Dockerfile, Compose, Makefile, deployment runbook, test scripts |

## Root, configuration, and orchestration

| File | Responsibility |
| --- | --- |
| [package.json](../package.json) | npm command registry; ES modules; `dotenv`, `pg`, `puppeteer` dependencies. `main: run.js` points to no root file; use scripts. |
| [package-lock.json](../package-lock.json) | Locked dependency graph consumed by `npm ci` |
| [.env.example](../.env.example) | Configuration template; see operations guide for precedence/default corrections |
| [config/env.js](../config/env.js) | Environment selection, layered dotenv loading, SSL default |
| [scripts/init-db.sh](../scripts/init-db.sh) | Apply schema and populate/enrich stores |
| [scripts/update-products.sh](../scripts/update-products.sh) | Recurring all-chain offer pipeline |
| [scripts/test.sh](../scripts/test.sh) | Unit suite, Compose DB startup, live sample integration |
| [Dockerfile](../Dockerfile) | Node 22 image, Chromium download skipped, unprivileged user, tini, recurring command |
| [docker-compose.yml](../docker-compose.yml) | Disposable PostgreSQL 17 and one-shot app configuration |
| [Makefile](../Makefile) | Build/full local smoke run/ECR push/ECS register/run shortcuts |
| [.gitignore](../.gitignore) | Excludes local secrets, dependencies, generated data/state |
| [.dockerignore](../.dockerignore) | Excludes main env profiles and generated artifacts from build context |
| [deploy/ecs-task-definition.json](../deploy/ecs-task-definition.json) | Fargate template with placeholders, image, runtime vars, secret refs, logging |

Local `.env` profiles contain environment-specific values. `.vscode/` and `.claude/` are editor/tool-local directories, not pipeline stages.

## Database

| File | Responsibility |
| --- | --- |
| [db/schema.sql](../db/schema.sql) | Fresh DDL, indexes, constraints, chain/category seeds |
| [db/pool.js](../db/pool.js) | Shared PostgreSQL pool and TLS options |
| [db/apply-schema.js](../db/apply-schema.js) | Executes schema with Node; closes pool and reports failure |
| [db/migration.sql](../db/migration.sql) | Legacy table reshape/drop statements; preserves stores/chains |
| [db/migrate.js](../db/migrate.js) | Runs legacy migration + fresh schema transactionally; no backup creation |

## Stores

| File | Responsibility |
| --- | --- |
| [stores/run.js](../stores/run.js) | Coop then ICA discovery, without DB import |
| [stores/coop/fetch.js](../stores/coop/fetch.js) | Bulk store list + detailed locations → JSON |
| [stores/ica/fetch.js](../stores/ica/fetch.js) | Locator HTML state → metadata and offers URLs |
| [stores/update_db.js](../stores/update_db.js) | Coop/ICA store upserts |
| [stores/scripts/import_stores.js](../stores/scripts/import_stores.js) | Willys committed JSON upsert, preserving geography |
| [stores/scripts/enrich_locations.js](../stores/scripts/enrich_locations.js) | Willys CMS coordinate/address enrichment for null-latitude rows |
| [stores/willys/willys_stores.json](../stores/willys/willys_stores.json) | Committed store inventory; also selects product-fetch representatives |
| [stores/willys/willys_sitemap.xml](../stores/willys/willys_sitemap.xml) | Saved discovery source artifact; not read by active npm commands |
| [stores/willys/willys_stores.js](../stores/willys/willys_stores.js) | Legacy GUI Puppeteer discovery requiring separate input preparation |

`stores/data/` is generated Coop/ICA discovery output; it is not relocated by `PIPELINE_DATA_ROOT`.

## Products and retailer adapters

| File | Responsibility |
| --- | --- |
| [products/run.js](../products/run.js) | Coop fetch/normalize, ICA fetch/normalize, pool shutdown |
| [products/update_db.js](../products/update_db.js) | Product/group/store observation upserts; transactional chain offer archival/replacement |
| [products/coop/fetch.js](../products/coop/fetch.js) | Offer API calls, ledger mapping, cluster expansion, initial price/GTIN shaping |
| [products/coop/normalize.js](../products/coop/normalize.js) | Coop categories, display cleanup, cross-store deduplication |
| [products/ica/fetch.js](../products/ica/fetch.js) | HTML state extraction, offer/EAN expansion, ICA deal mechanics |
| [products/ica/normalize.js](../products/ica/normalize.js) | ICA categories/traits and product/store-offer aggregation |
| [products/willys/fetch.js](../products/willys/fetch.js) | Campaign facet discovery/pagination, two assortments, Axfood-image GTIN extraction, exact-code catalog recovery, and exact-promotion expansion for mix-and-match campaigns |
| [products/willys/normalize.js](../products/willys/normalize.js) | Willys categories/labels and normalized assortment offers |
| [products/categories/displayCategories.js](../products/categories/displayCategories.js) | Eleven shared category slugs and Swedish labels; keep SQL seeds aligned |
| [products/categories/badges.js](../products/categories/badges.js) | ICA traits/Willys labels → slug, label, type, optional remote icon |

Each chain's `data/`, `normalized/`, and `.state/` directories are generated. State holds checkpoints, schema baselines, and (Coop) cache data. Normalizers have retailer category maps in their own files.

## Shared product utilities

| File under `products/lib/` | Responsibility |
| --- | --- |
| [config.js](../products/lib/config.js) | Required env lookup, integer tuning, shared user agent; imports central environment loader |
| [paths.js](../products/lib/paths.js) | Product artifact/state roots and normalized filename conventions |
| [httpClient.js](../products/lib/httpClient.js) | HTTP text/JSON requests, retry, timeout, pacing, optional cache |
| [httpCache.js](../products/lib/httpCache.js) | Disk response cache keyed by URL digest and freshness headers |
| [concurrency.js](../products/lib/concurrency.js) | Bounded workers and additional failed-item passes |
| [checkpoint.js](../products/lib/checkpoint.js) | Persist/clear completed IDs for interrupted-run resume |
| [schemaCheck.js](../products/lib/schemaCheck.js) | Sampled upstream response-shape drift detection |
| [logger.js](../products/lib/logger.js) | Scoped severity logging |
| [metrics.js](../products/lib/metrics.js) | Fetch counters/timing/schema summaries |
| [gtin.js](../products/lib/gtin.js) | Barcode checksum, canonical normalization, restricted-code classification |
| [fingerprint.js](../products/lib/fingerprint.js) | Fallback product identity string construction |
| [priceParsing.js](../products/lib/priceParsing.js) | Swedish price text → integer öre |
| [comparisonPrice.js](../products/lib/comparisonPrice.js) | Comparison bounds/unit parsing and multi-buy per-item fallback |

## Tests and context documents

| File | Responsibility |
| --- | --- |
| [test/unit/parsers.test.js](../test/unit/parsers.test.js) | Comparison price, price parsing, fingerprint tests |
| [test/unit/gtin.test.js](../test/unit/gtin.test.js) | Canonical GTIN/checksum/restricted-code tests; existed as untracked work at review |
| [test/integration/pipeline.test.js](../test/integration/pipeline.test.js) | Live sample fetch/import invariants and second-load archival |
| [test/helpers/db.js](../test/helpers/db.js) | Disposable DB guard, destructive schema reset, fixture seeding, count helper |
| [test/helpers/pipeline.js](../test/helpers/pipeline.js) | Real entrypoints as subprocesses with temporary product root |
| [test/fixtures/stores.json](../test/fixtures/stores.json) | Six physical test stores, two per chain |
| [test/README.md](../test/README.md) | Test command reference |
| [docs/product-identity.md](product-identity.md) | Historical requirements, previous approach, unresolved identity decisions |
| [deploy/README.md](../deploy/README.md) | Manual release and AWS setup runbook |
| [AGENTS.md](../AGENTS.md) | Minimal context and working guidance for future agents |

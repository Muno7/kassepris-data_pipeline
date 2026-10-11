# Tests

[Documentation home](../README.md) · [Detailed testing and operations guide](../docs/development.md#tests)

Status at the 2026-09-15 documentation review: 11 offline unit tests passed.
Full integration was not run. Willys products without recoverable GTINs are
logged and skipped so they do not prevent the full pipeline from loading.

Run after each change:

```bash
npm test              # unit + integration (brings the test Postgres up)
npm run test:unit     # pure functions only - no DB/network, milliseconds
npm run test:integration
```

## Two layers

**Unit** (`test/unit/`) — pure-function tests (comparison-price ranges, price
parsing, fingerprint stability, GTIN normalization/restricted classification).
No DB or network.

**Integration** (`test/integration/`) — runs the **real** pipeline
(`run.js` → Willys fetch/normalize → `update_db.js`) on a **small live sample**
into a disposable Postgres, then asserts the structural invariants:

- data actually ingested;
- no product in two current offers at the same store (the core business rule);
- comparison `min ≤ max`, and real ranges are preserved;
- `valid_from` never in the future or after `valid_until`;
- mix-and-match (multi-product) offers exist;
- referential integrity of offers/store_products;
- replacement: a second load discards the prior current offers without
  doubling them, while GTIN product identities persist.

Most checks test structural invariants. Assertions requiring a real comparison
range and a multi-product offer also depend on the live sample, so changing
weekly data can fail them. Aggregate counts do not prove every chain succeeded.
Runtime varies with retailer responses, pacing, and retries.

## The sample

`test/fixtures/stores.json` seeds exactly 2 stores per chain. Coop/ICA read their
store list **from the DB**, so seeding N is what bounds the fetch to N — that's
why it's seconds instead of the ~20 minutes a full fetch of all ~2,300 stores
takes. The pipeline writes to a throwaway temp dir (`PIPELINE_DATA_ROOT`), so a
test run never touches your real `products/*/data` working files.

## Requirements

- **Test Postgres.** Use the disposable container: `docker compose up -d db`
  (port 5433). Explicitly set `DB_URL` or configure `.env.test`; the local file
  is not distributed with this repository. `npm test` starts PostgreSQL;
  `npm run test:integration` does not.
- **Network** (it fetches a live sample) and the **Coop keys** (from `.env`).

The entire `public` schema is dropped and recreated each run. The harness
uses a URL regex matching `kassepris_test` or `:5433`; this is only a guard,
not proof the database is disposable. Explicitly verify the target:

```bash
APP_ENV=test DB_SSL=false \
DB_URL=postgresql://kassepris:kassepris@localhost:5433/kassepris_test \
npm test
```

`make test` is a different workflow: full live store setup and ingestion in
Compose, followed by row counts. `make test-down` deletes its database volume.

### No Docker handy?

Any local Postgres works — just make a throwaway db named `kassepris_test`:

```bash
createdb kassepris_test
DB_URL=postgresql://USER@localhost:5432/kassepris_test APP_ENV=test npm run test:integration
```

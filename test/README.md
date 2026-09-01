# Tests

Run after each change:

```bash
npm test              # unit + integration (brings the test Postgres up)
npm run test:unit     # pure functions only - no DB/network, milliseconds
npm run test:integration
```

## Two layers

**Unit** (`test/unit/`) — pure-function tests (comparison-price ranges, price
parsing, fingerprint stability). No DB, no network. Milliseconds.

**Integration** (`test/integration/`) — runs the **real** pipeline
(`run.js` → Willys fetch/normalize → `update_db.js`) on a **small live sample**
into a disposable Postgres, then asserts the structural invariants:

- data actually ingested;
- no product in two current offers at the same store (the core business rule);
- comparison `min ≤ max`, and real ranges are preserved;
- `valid_from` never in the future or after `valid_until`;
- mix-and-match (multi-product) offers exist;
- referential integrity of offers/store_products;
- archival: a second load moves the prior cycle to `historical_offers` without
  doubling the current offers.

These invariants hold for **any** valid data, so weekly offer changes never
cause false failures — the sample doesn't need to be frozen. ~7-20s (mostly
ICA's rate-limited sample fetch).

## The sample

`test/fixtures/stores.json` seeds ~2 stores per chain. Coop/ICA read their
store list **from the DB**, so seeding N is what bounds the fetch to N — that's
why it's seconds instead of the ~20 minutes a full fetch of all ~2,300 stores
takes. The pipeline writes to a throwaway temp dir (`PIPELINE_DATA_ROOT`), so a
test run never touches your real `products/*/data` working files.

## Requirements

- **Test Postgres.** Default is the disposable container: `docker compose up -d db`
  (port 5433; `.env.test` points `DB_URL` there). `npm test` brings it up for you.
- **Network** (it fetches a live sample) and the **Coop keys** (from `.env`).

The DB is fully reset each run (drops + re-applies `db/schema.sql`), so the
harness **refuses any `DB_URL` that isn't clearly the test DB** (`kassepris_test`
or `:5433`) — a guard against pointing it at a real database.

### No Docker handy?

Any local Postgres works — just make a throwaway db named `kassepris_test`:

```bash
createdb kassepris_test
DB_URL=postgresql://USER@localhost:5432/kassepris_test APP_ENV=test npm run test:integration
```

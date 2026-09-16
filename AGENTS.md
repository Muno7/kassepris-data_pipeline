# Agent context

## Purpose and reading order

This repository is Kassepris's Node.js ES-module batch pipeline for Swedish Coop, ICA, and Willys promotional offers. PostgreSQL is the persistent store; JSON files are intermediate artifacts. There is no application server here.

1. Read [README.md](README.md) for scope and current limitations.
2. Use [docs/repository-map.md](docs/repository-map.md) to select files relevant to the task.
3. Read [docs/architecture.md](docs/architecture.md) before changing data semantics or ingestion.
4. Read [docs/development.md](docs/development.md) for commands/configuration, or [deploy/README.md](deploy/README.md) for deployment.

## Entry points and invariants

- `scripts/init-db.sh`: schema + store discovery/import + Willys location enrichment; separate from recurring ingestion.
- `scripts/update-products.sh`: Coop/ICA fetch+normalize → Willys fetch → Willys normalize → `products/update_db.js`.
- `products/run.js` runs Coop/ICA only. Their fetch/normalize modules export functions; invoking a normalizer file directly does not execute its function.
- Coop/ICA products select stores from PostgreSQL. Willys fetches newspaper assortments using `stores/willys/willys_stores.json`; import fans these out to physical stores by name (`Hemma`).
- Prices are integer öre/cents; a multi-buy price is the whole bundle. Comparison prices have min/max and a unit. Offers may apply to several products.
- Import runs in one transaction. Present files replace current offers per chain after archiving them; missing files leave that chain untouched. Products/groups/store observations persist.
- `store_products` means observed through this feed, not complete assortment or current stock.
- `PIPELINE_DATA_ROOT` relocates product artifacts, not store discovery files or the Willys input fixture.

## Working practices

- Start with `git status --short` and inspect relevant diffs. Preserve unrelated/staged/untracked work. The initial documentation review found identity work already in progress; re-check rather than assuming it is still unchanged.
- Keep retailer-specific transformations in that retailer's modules and shared behavior in `products/lib/`. Update documentation when commands, contracts, or deployment behavior change.
- Do not copy `.env`/`.env.test` values into documentation, output, or commits. Use `.env.example` for configuration discovery.
- Prefer `npm run test:unit` for offline verification. Integration tests use live retailers and **drop the test database's public schema**; verify a disposable database explicitly. `make test` is a full live refresh, not the unit suite.
- `db:migrate` drops product/offer/history tables; it is a legacy redesign tool, not a generic schema upgrade or the unfinished identity migration. It does not create a backup.
- Host `db:init` sources `.env` as shell code and can override exported settings; prefer the documented Compose setup.
- Do not infer AWS deployment state from the template. Check image tag/architecture and task revision when a deployment task is requested.

## Known seams to re-check

As inspected 2026-09-15:

- All three retailer paths normalize valid GTINs before the importer performs its
  unified lookup; the importer normalizes again at its input boundary and writes
  restricted-circulation classification. Missing GTINs are still skipped.
- Schema identity fields are ahead of a complete fallback-identity implementation.
  The fresh DDL now requires exactly one of GTIN/fingerprint, but applying it does
  not migrate existing table definitions.
- [docs/product-identity.md](docs/product-identity.md) records requirements/history, not a completed migration. Keep image work separate from identity work.
- Partial fetch errors need not fail the process. Raw output may be stale; no complete-snapshot validation exists before chain replacement.
- No CI/CD workflow is checked in. Future CI should distinguish offline tests, disposable live integration, image build, and production release.

For a handoff, state what changed, checks actually run, unresolved limitations, and any unverified external state. Remove resolved caveats from these guides when the implementation changes.

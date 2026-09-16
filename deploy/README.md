# Deploy: build → test locally → push to ECR → run on Fargate

[Documentation home](../README.md) · [Development and operations](../docs/development.md)

## Repository status and release checks

Reviewed from source on 2026-09-15. Live AWS resources, task revision, and
schedule were not inspected. No CI/CD workflow or infrastructure provisioner
is checked in.

- Resolve the current Willys GTIN import mismatch before a full run; see
  [current limitations](../README.md#current-limitations-to-know-before-running).
- The task template specifies Linux **X86_64**, 1 vCPU and 2 GiB memory.
  Build `linux/amd64` for that template, including from Apple Silicon.
- Make variables **do not render** `ecs-task-definition.json`. Set the exact
  pushed image tag, account, region, and actual role/secret ARNs in the JSON
  before registering. Its checked-in image uses `latest`.
- Compose's app image is fixed at `kassepris-scraper:latest`; its smoke run
  does not automatically test a separately tagged release image.
- Runtime files/checkpoints are ephemeral; no persistent artifact volume is
  configured. A replacement task starts with fresh local state.

The recurring job is `products:update-all` (fetch Coop/ICA/Willys offers,
normalize, load current offers, archive the previous cycle). It runs to
completion and exits — a scheduled batch task, not a server. Store/schema
setup (`db:init`) is a separate one-time step per database.

All image/AWS settings are driven by `make` variables — override per command:

```bash
make <target> AWS_ACCOUNT_ID=123456789012 AWS_REGION=eu-north-1 IMAGE_TAG=$(git rev-parse --short HEAD)
```

## 0. Prerequisites
- Docker Desktop (local build/test).
- AWS CLI v2, authenticated (`aws sts get-caller-identity`).
- A Postgres (AWS RDS) for production; local test uses the throwaway Postgres
  in `docker-compose.yml`.

## 1. Build + test locally (every code change)
```bash
make build       # docker build -t kassepris-scraper:latest .
make test        # up test Postgres -> db:init (schema+stores) -> pipeline -> row counts
make test-down   # tear down + drop the test DB volume
```
`make test` uses `APP_ENV=development`, `DB_SSL=false`, and a DB_URL pointing at
the compose Postgres; your host `.env` supplies the Coop keys at runtime (never
baked into the image). Runtime depends on pacing, retries and retailer responses.
Check per-chain coverage and failures as well as non-zero overall row counts.
`make test` is a full live smoke run, distinct from `npm test`'s sample suite.

## 2. One-time AWS setup
```bash
# ECR repository
make ecr-create

# CloudWatch log group
aws logs create-log-group --log-group-name /ecs/kassepris-scraper --region <REGION>

# Secrets (values injected into the task at runtime, never in the image/task def)
aws secretsmanager create-secret --name kassepris/DB_URL --secret-string \
  "postgresql://USER:PASS@YOUR-RDS-HOST:5432/kassepris" --region <REGION>
aws secretsmanager create-secret --name kassepris/COOP_PRODUCTS_SUBSCRIPTION_KEY --secret-string "..." --region <REGION>
aws secretsmanager create-secret --name kassepris/COOP_STORE_INFO_SUBSCRIPTION_KEY --secret-string "..." --region <REGION>
```

IAM roles:
- **Execution role** (`kassepris-ecs-execution-role`) — trusts `ecs-tasks.amazonaws.com`;
  attach `AmazonECSTaskExecutionRolePolicy` plus `secretsmanager:GetSecretValue`
  on the three secrets above (needed to pull the image + inject secrets + write logs).
- **Task role** (`kassepris-task-role`) — trusts `ecs-tasks.amazonaws.com`; no
  permissions required (the job only makes outbound HTTP + talks to RDS over the network).

Put both role ARNs, the account id, and region into `deploy/ecs-task-definition.json`
(replace the `<ACCOUNT_ID>`/`<REGION>` placeholders).

## 3. Push the image
```bash
make push        # build + ecr-login + tag + push to <acct>.dkr.ecr.<region>.amazonaws.com/kassepris-scraper:<tag>
```

For an explicitly tagged X86_64 release image (replace example values):

```bash
DOCKER_DEFAULT_PLATFORM=linux/amd64 make push \
  AWS_ACCOUNT_ID=123456789012 AWS_REGION=eu-north-1 IMAGE_TAG=<release-tag>
```

`make push` always builds. Put the matching image URI in the task definition;
changing the Make tag alone does not update the task. Use a unique release tag
when traceability matters; a Git SHA alone does not describe uncommitted changes.

## 4. Register the task definition
```bash
make register-task
```

Record the returned task-definition revision and image tag. This command reads
the JSON file as-is. Confirm placeholders have been replaced before invoking it.

## 5. Initialize the production database (once)
Run setup as a one-off ECS task with the same network/secrets configuration,
overriding the `scraper` container command to `["npm", "run", "db:init"]`.
The default task command only updates products; it does not initialize stores.

Prefer container initialization: on a host, `scripts/init-db.sh` sources `.env`
and can overwrite inline production `DB_URL`/`APP_ENV` settings. Inside the
image there is no `.env` file, and the task injects configuration directly.
`db:init` applies the schema and populates stores (Coop/ICA fetched live, Willys
imported from the committed list). Migrating an existing legacy DB instead? use
`node db/migrate.js` only after reviewing its legacy assumptions and creating a
backup separately. It drops product/offer/history data, does not create a backup,
and is not the unfinished product-identity migration. Reapplying `db:schema`
does not update existing table columns to match changed DDL.

## 6. Manual production run (verify before scheduling)
```bash
make run-task CLUSTER=kassepris SUBNETS=subnet-aaa,subnet-bbb SG=sg-xxx
```
The Make shortcut selects the task family named by `ECR_REPO` (default
`kassepris-scraper`), not a pinned revision, and requests a public IP. Confirm
the family/revision and network access to retailers and RDS before running.

Watch CloudWatch Logs (`/ecs/kassepris-scraper`) and inspect the stopped task's
exit details. A successful launch or exit 0 is insufficient: partial fetch
failures can still complete successfully. Check fetch/import summaries and
per-chain database coverage using the [operations guide](../docs/development.md).

## 7. Schedule the weekly run
Use **EventBridge Scheduler** → target **ECS RunTask** with this task definition,
the Fargate launch type, and your cluster/subnets/security-group. A weekly cron
(e.g. `cron(0 6 ? * MON *)`) matches the weekly offer cycle. The scheduler's role
needs `ecs:RunTask` + `iam:PassRole` for the task/execution roles.

The schedule is configured outside this repository; confirm its timezone and
target revision in AWS. Avoid overlapping imports: there is no application
lock protecting concurrent refreshes. Updating a task definition does not by
itself verify or update an externally configured schedule target.

## Recovery

Retain the previous image tag and task-definition revision so a code rollback
can select them explicitly. The Make run shortcut alone selects a family,
so use an explicit revision in the ECS console/CLI when rolling back.
Rolling back an image does not reverse database writes. A repeated import
archives another snapshot, and this repository has no restore-from-history
command. Database recovery depends on separately managed backups and the
specific failed operation.

## Config reference (production env)
Set on the task (non-secret) — see the task definition:
`APP_ENV=production`, `DB_SSL=true`, and the declared-limit politeness:
`ICA_FETCH_MIN_DELAY_MS=850` (ICA's 72/60s), `WILLYS_FETCH_MIN_DELAY_MS=10000` +
`WILLYS_FETCH_CONCURRENCY=1` (Willys robots Crawl-delay: 10s), Coop unset (no
declared limit). Secrets (`DB_URL`, `COOP_*`) come from Secrets Manager.

Those pacing comments record the source's prior observations, not policies
revalidated during this documentation review. `APP_ENV=production` alone does
not set Willys delay/concurrency. See the operations guide for effective defaults.

# Deploy: build → test locally → push to ECR → run on Fargate

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
baked into the image). Expect ICA's product fetch to take ~13 min (its 72/60s
rate limit). A healthy run ends with non-zero `offers`/`products` counts.

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

## 4. Register the task definition
```bash
make register-task
```

## 5. Initialize the production database (once)
Run the setup command as a one-off task (override the container command), or run
it locally against RDS:
```bash
# locally against RDS (simplest):
APP_ENV=production DB_SSL=true \
  DB_URL="postgresql://USER:PASS@YOUR-RDS-HOST:5432/kassepris" \
  COOP_PRODUCTS_SUBSCRIPTION_KEY=... COOP_STORE_INFO_SUBSCRIPTION_KEY=... \
  npm run db:init
```
`db:init` applies the schema and populates stores (Coop/ICA fetched live, Willys
imported from the committed list). Migrating an existing legacy DB instead? use
`node db/migrate.js`.

## 6. Manual production run (verify before scheduling)
```bash
make run-task CLUSTER=kassepris SUBNETS=subnet-aaa,subnet-bbb SG=sg-xxx
```
Watch it in CloudWatch Logs (`/ecs/kassepris-scraper`). It should finish in
~15 min and exit 0.

## 7. Schedule the weekly run
Use **EventBridge Scheduler** → target **ECS RunTask** with this task definition,
the Fargate launch type, and your cluster/subnets/security-group. A weekly cron
(e.g. `cron(0 6 ? * MON *)`) matches the weekly offer cycle. The scheduler's role
needs `ecs:RunTask` + `iam:PassRole` for the task/execution roles.

## Config reference (production env)
Set on the task (non-secret) — see the task definition:
`APP_ENV=production`, `DB_SSL=true`, and the declared-limit politeness:
`ICA_FETCH_MIN_DELAY_MS=850` (ICA's 72/60s), `WILLYS_FETCH_MIN_DELAY_MS=10000` +
`WILLYS_FETCH_CONCURRENCY=1` (Willys robots Crawl-delay: 10s), Coop unset (no
declared limit). Secrets (`DB_URL`, `COOP_*`) come from Secrets Manager.

# Kassepris scraper - build / test-local / push-to-ECR workflow.
#
# Override config on the CLI or via env, e.g.
#   make push AWS_ACCOUNT_ID=123456789012 AWS_REGION=eu-north-1 IMAGE_TAG=$(git rev-parse --short HEAD)
#
# Typical loop after a code change:
#   make build          # build the image locally
#   make test           # spin up test Postgres, init schema+stores, run pipeline
#   make test-down      # tear the test stack down
#   make push           # tag + push to ECR (build first if needed)

AWS_REGION     ?= eu-north-1
AWS_ACCOUNT_ID ?= 000000000000
ECR_REPO       ?= kassepris-scraper
IMAGE_TAG      ?= latest

IMAGE        := $(ECR_REPO):$(IMAGE_TAG)
ECR_REGISTRY := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
ECR_IMAGE    := $(ECR_REGISTRY)/$(IMAGE)

.PHONY: build test test-db test-init test-run test-psql test-down \
        ecr-login ecr-create push register-task run-task

## --- Build -------------------------------------------------------------
build:
	docker build -t $(IMAGE) .

## --- Local test (against the disposable Postgres in docker-compose.yml) --
test-db:
	docker compose up -d db

test-init: test-db
	docker compose run --rm app npm run db:init

test-run:
	docker compose run --rm app npm run products:update-all

test-psql:
	docker compose exec db psql -U kassepris -d kassepris_test -c \
	  "SELECT (SELECT count(*) FROM offers) offers, (SELECT count(*) FROM products) products, (SELECT count(*) FROM stores) stores;"

# Full local test: schema + stores, then the pipeline, then a row-count check.
test: test-init test-run test-psql

test-down:
	docker compose down -v

## --- ECR ---------------------------------------------------------------
ecr-login:
	aws ecr get-login-password --region $(AWS_REGION) \
	  | docker login --username AWS --password-stdin $(ECR_REGISTRY)

ecr-create:
	aws ecr describe-repositories --repository-names $(ECR_REPO) --region $(AWS_REGION) >/dev/null 2>&1 \
	  || aws ecr create-repository --repository-name $(ECR_REPO) --region $(AWS_REGION)

push: build ecr-login
	docker tag $(IMAGE) $(ECR_IMAGE)
	docker push $(ECR_IMAGE)
	@echo "pushed $(ECR_IMAGE)"

## --- Fargate (see deploy/README.md for one-time setup) -----------------
register-task:
	aws ecs register-task-definition --region $(AWS_REGION) \
	  --cli-input-json file://deploy/ecs-task-definition.json

# One-off manual production run (weekly job). Requires CLUSTER, SUBNETS, SG.
run-task:
	aws ecs run-task --region $(AWS_REGION) --launch-type FARGATE \
	  --cluster $(CLUSTER) --task-definition $(ECR_REPO) \
	  --network-configuration "awsvpcConfiguration={subnets=[$(SUBNETS)],securityGroups=[$(SG)],assignPublicIp=ENABLED}"

# Vault Rush — Operations Runbook

How to run, observe and repair the system. Architecture background is in
[`architecture.md`](architecture.md); infrastructure code is in `infrastructure/`.

## 1. Local development

The compose stack (`docker-compose.yml` at the repo root) runs the full topology with
local stand-ins for AWS:

| Service | Image / build | Port | Purpose |
|---------|---------------|------|---------|
| `api` | `infrastructure/docker/api.Dockerfile` | 8080 | HTTP API |
| `worker` | `infrastructure/docker/worker.Dockerfile` | — | SQS consumer + scheduler |
| `client` | `infrastructure/docker/client.Dockerfile` (nginx) | 8081 | Player client |
| `admin` | `infrastructure/docker/admin.Dockerfile` (nginx, proxies `/admin/`, `/healthz`, `/readyz`, `/metrics` to `api`) | 8082 | LiveOps dashboard |
| `redis` | `redis:7-alpine` | 6379 | Cache / leaderboard |
| `dynamodb` | `amazon/dynamodb-local` | 8000 | Storage |
| `elasticmq` | `softwaremill/elasticmq-native` with `infrastructure/docker/elasticmq.conf` | 9324 (9325 stats UI) | SQS |

```sh
docker compose up --build                       # everything
./infrastructure/docker/dynamodb/create-table.sh  # idempotent; run once after dynamodb is up (compose may do it for you)
curl -s localhost:8080/healthz                    # {"status":"ok"}
curl -s localhost:8080/readyz | jq                # deps: redis, dynamodb, queue
```

Dependency-free mode for quick iteration on the API alone:

```sh
cd backend && STORAGE=memory CACHE=memory QUEUE=inline ADMIN_TOKEN=local-admin-token TOKEN_SECRET=change-me go run ./cmd/api
```

Test suites:

```sh
cd backend && go test -race ./...                       # unit (memory implementations)
cd backend && go test -race -tags=integration ./...     # against compose redis/dynamodb/elasticmq
cd client && npm test                                   # Vitest incl. engine golden fixtures
cd load-tests/k6 && k6 run -e BASE_URL=http://localhost:8080 smoke.js
```

## 2. Environment variables

Consumed by both `api` and `worker` unless noted.

| Variable | Local | Production | Notes |
|----------|-------|------------|-------|
| `PORT` | `8080` | `8080` | HTTP listen port |
| `ENV` | `local` | `production` | Affects log format and defaults |
| `STORAGE` | `dynamodb` / `memory` | `dynamodb` | |
| `CACHE` | `redis` / `memory` | `redis` | `memory` also switches the rate limiter to per-process |
| `QUEUE` | `sqs` / `inline` | `sqs` | `inline` runs worker handlers inside the API |
| `REDIS_ADDR` | `redis:6379` | `<elasticache-primary>:6379` | Terraform output `redis_endpoint` |
| `DYNAMODB_ENDPOINT` | `http://dynamodb:8000` | *(unset)* | Empty/unset = real AWS |
| `DYNAMODB_TABLE` | `vault_rush` | `vault_rush` | |
| `AWS_REGION` | `eu-central-1` | `eu-central-1` | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `local` / `local` | *(unset — task role)* | DynamoDB Local and ElasticMQ accept any value |
| `SQS_QUEUE_URL` | `http://elasticmq:9324/000000000000/vault-rush-events` | Terraform output `sqs_queue_url` | |
| `SQS_ENDPOINT` | `http://elasticmq:9324` | *(unset)* | Empty/unset = real AWS |
| `ADMIN_TOKEN` | `local-admin-token` | SSM SecureString → ECS secret | `X-Admin-Token` header |
| `TOKEN_SECRET` | `change-me` | SSM SecureString → ECS secret | Signs player bearer tokens; rotating it logs every player out |
| `TELEMETRY_WORKERS` | `8` | `8` | Goroutines draining the telemetry channel |
| `TELEMETRY_BUFFER` | `1000` | `1000` | Channel capacity; full channel = dropped events |
| `RATE_LIMIT_PER_MIN` | `100` | `100` | Token bucket per player |
| `CORS_ORIGINS` | `*` | client origin(s) | Comma-separated |
| `LOG_LEVEL` | `info` | `info` | `debug` is verbose per request |

In production the values live in the ECS task definition (Terraform: `locals.tf`,
`container_environment`) and in SSM for the two secrets.

## 3. Rotating `ADMIN_TOKEN`

Secrets are read once at task start, so rotation is "change the parameter, roll the
tasks". The API has no notion of two valid tokens, so there is a short window in which
old dashboards get `403 FORBIDDEN`; do it outside a LiveOps session.

```sh
NEW_TOKEN="$(openssl rand -hex 24)"
aws ssm put-parameter --name /vault-rush/prod/ADMIN_TOKEN --type SecureString --overwrite --value "$NEW_TOKEN"

# Roll only the API (the worker does not use ADMIN_TOKEN).
aws ecs update-service --cluster vault-rush-prod --service vault-rush-prod-api --force-new-deployment
aws ecs wait services-stable --cluster vault-rush-prod --services vault-rush-prod-api

# Verify: old token rejected, new token accepted.
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Admin-Token: $OLD_TOKEN" https://api.example.com/admin/v1/system   # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Admin-Token: $NEW_TOKEN" https://api.example.com/admin/v1/system   # 200
```

Then update the token in the admin dashboard (it is entered by the operator, never
baked into the static build). Terraform ignores changes to the parameter value
(`lifecycle.ignore_changes`), so the next `terraform apply` will not revert the rotation.

`TOKEN_SECRET` rotates the same way, but every issued player token becomes invalid:
clients must re-`POST /v1/player` with their `deviceId` (they resume the same player).
Roll both `api` and `worker` if the worker verifies tokens.

Locally: change the value in `.env` / compose and `docker compose up -d api`.

## 4. Reading `/metrics`

`GET /metrics` returns JSON counters (no auth; not exposed publicly in production — reach
it through the admin distribution, which proxies `/metrics`, or from inside the VPC).
The admin's system page renders the same data from `GET /admin/v1/system`.

| Field | What to look at |
|-------|-----------------|
| `requests` by route/status | 4xx spikes on `finish` → client bug or cheating attempt (`422` codes); 5xx → dependency |
| latency histogram | Compare p95 with the load-test baselines in `load-testing.md` |
| `telemetry.queueDepth` vs `capacity` | Depth near capacity → sinks are slow (SQS) or workers too few; increase `TELEMETRY_WORKERS` or investigate SQS latency |
| `telemetry.dropped` | Any increase is lost analytics; correlate with `queueDepth` and `retries` |
| `telemetry.retries` | SQS publish retries; sustained growth → SQS/VPC endpoint problem |
| `deps.*` | Same as `/readyz` |

```sh
curl -s https://ops.example.com/metrics | jq '.telemetry'
watch -n2 'curl -s localhost:8080/metrics | jq -c ".telemetry"'
```

CloudWatch (production): log groups `/vault-rush-prod/api` and `/vault-rush-prod/worker`;
alarms `vault-rush-prod-api-5xx`, `-api-unhealthy-hosts`, `-api-latency-p95`,
`-events-dlq-not-empty`, `-events-oldest-message-age`, `-redis-memory-high`.

```sh
aws logs tail /vault-rush-prod/api --since 15m --follow --format short
aws logs tail /vault-rush-prod/api --since 1h --filter-pattern '{ $.requestId = "REQ_ID" }'
```

## 4b. Enabling production deploys

`deploy.yml` is opt-in. It runs its AWS jobs only when the repository variable
`DEPLOY_ENABLED` equals `true`; otherwise it records a "deploy skipped" notice so the
workflow stays green on forks and on repositories without AWS behind them. Enable it after
`terraform apply` by copying `terraform output github_actions_variables` into the
`production` environment and setting `DEPLOY_ENABLED=true` under Settings → Secrets and
variables → Actions → Variables.

## 5. When Redis is down

**Symptoms:** `/readyz` returns 503 with `deps.redis != ok`; `GET /v1/leaderboard/*`
returns `503 DEPENDENCY_UNAVAILABLE`; `me.rank` missing from `/v1/events/current`;
`telemetry`/sink retry counters rising; `redis-memory-high` alarm may have preceded it.

**What still works:** everything that matters for money and progress. Runs start and
finish (DynamoDB is the source of truth), rewards are created and claimed, purchases
apply. The rate limiter fails open (requests are allowed, a warning is logged). ALB
health checks use `/healthz`, so tasks stay in rotation.

**What is degraded:** leaderboard reads, rank display, config cache (falls through to
DynamoDB — higher latency on `events/current`), cross-task rate limiting.

**Actions:**

1. Identify the cause: `aws elasticache describe-events --source-type replication-group --duration 60`;
   check the memory alarm (with `noeviction`, a full node rejects writes but stays "up").
2. Memory full: scale the node type (`redis_node_type` in Terraform, `apply_immediately`
   is false by default — set it for an incident) or, as a stop-gap, delete leaderboard
   keys of ended events (`SCAN 0 MATCH lb:*`, keep the current event).
3. Node failure with `redis_num_nodes = 1`: ElastiCache replaces the node; data is lost
   and the leaderboard is empty when it returns.
4. After recovery, scores whose `ZADD` kept failing are in the dead-letter queue (SQS
   mode) — replay it (§6); every leaderboard write is `ZADD GT`, so replaying is safe.
   In inline mode the pipeline retried for a few seconds and then dropped the update
   (`telemetry.failed` counts them); those players re-enter the board with their next
   finished run. A backfill job from `RUN#` items is a planned follow-up (ADR-006).
5. Confirm: `/readyz` green, `GET /v1/leaderboard/global` returns `total > 0`,
   sink retry counter flat.

Consider `redis_num_nodes = 2` (automatic failover, Multi-AZ) if step 3 happens more than
once.

## 6. DLQ replay

A message reaches `vault-rush-events-dlq` after 5 failed receives. The alarm
`vault-rush-prod-events-dlq-not-empty` fires within 5 minutes.

1. **Look before replaying** — the message failed five times for a reason:
   ```sh
   DLQ=$(aws sqs get-queue-url --queue-name vault-rush-events-dlq --query QueueUrl --output text)
   aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
   aws sqs receive-message --queue-url "$DLQ" --max-number-of-messages 5 --visibility-timeout 0 | jq '.Messages[].Body | fromjson'
   ```
   Cross-reference with worker logs: `aws logs tail /vault-rush-prod/worker --since 2h --filter-pattern '"ERROR"'`.
2. **Fix the cause** — a bad deploy (roll back, §8), a malformed event from a specific
   API version (fix and deploy), a DynamoDB condition the handler does not expect.
3. **Redrive** with the SQS message-move API (moves everything back to the source queue
   at a controlled rate):
   ```sh
   SRC_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
   aws sqs start-message-move-task --source-arn "$SRC_ARN" --max-number-of-messages-per-second 50
   aws sqs list-message-move-tasks --source-arn "$SRC_ARN"
   ```
   Because the DLQ's redrive-allow policy names only `vault-rush-events`, omitting
   `--destination-arn` sends the messages back there.
4. **Poison messages** (will never succeed, e.g. an event type removed on purpose):
   purge after recording them — `aws sqs purge-queue --queue-url "$DLQ"`.
5. Confirm the alarm returns to OK and `ApproximateAgeOfOldestMessage` on the main
   queue drops.

Locally, ElasticMQ does not implement message-move tasks; use a short loop of
`receive-message` → `send-message` → `delete-message` against `http://localhost:9324`,
or simply restart the stack (queues are in-memory).

## 7. Scaling knobs

| Layer | Knob | Where | Notes |
|-------|------|-------|-------|
| API tasks | `api_min_count`, `api_max_count`, `api_cpu_target_percent`, `api_requests_per_target` | Terraform | Requests-per-target reacts faster than CPU for this I/O-bound service |
| API task size | `api_cpu`, `api_memory` | Terraform | Replay is the only CPU-heavy step; profile before growing |
| Worker tasks | `worker_min_count`, `worker_max_count`, `worker_queue_depth_target` | Terraform | Scale-out on `ApproximateNumberOfMessagesVisible` |
| Telemetry | `TELEMETRY_WORKERS`, `TELEMETRY_BUFFER` | env / `extra_environment` | More workers = more SQS concurrency; bigger buffer = more memory, later drops |
| Rate limit | `RATE_LIMIT_PER_MIN` | env | Per player; raise for load tests |
| Redis | `redis_node_type`, `redis_num_nodes` | Terraform | Vertical first (single-key sorted sets); 2 nodes for HA |
| DynamoDB | — | on-demand | Watch `ThrottledRequests`; hot partition = one player or one event partition being hammered |
| Graceful drain | `stop_timeout_seconds` | Terraform | Must exceed HTTP drain + telemetry flush; Fargate max 120 |
| ALB | `idle_timeout` (60) | Terraform | Raise only if long-polling is ever added |

Emergency manual scaling (autoscaling will adjust later within min/max):

```sh
aws ecs update-service --cluster vault-rush-prod --service vault-rush-prod-api --desired-count 6
```

## 8. Deploy and rollback

- **Deploy:** merge to `main` → `CI` → `Deploy` (GitHub environment `production`, requires
  approval). Images are tagged with the commit SHA; the ECS task definition is rendered
  from the current one with only the image replaced; the service rolls with the circuit
  breaker enabled and the workflow waits for stability.
- **Automatic rollback:** if new tasks fail health checks, ECS's deployment circuit
  breaker reverts to the previous task definition without intervention.
- **Manual rollback:** point the service at the previous revision (revisions are kept):
  ```sh
  aws ecs describe-services --cluster vault-rush-prod --services vault-rush-prod-api --query 'services[0].deployments[].taskDefinition'
  aws ecs list-task-definitions --family-prefix vault-rush-prod-api --sort DESC --max-items 5
  aws ecs update-service --cluster vault-rush-prod --service vault-rush-prod-api --task-definition vault-rush-prod-api:<previous-revision>
  aws ecs wait services-stable --cluster vault-rush-prod --services vault-rush-prod-api
  ```
- **Static sites:** the buckets are versioned; restoring `index.html` to the previous
  version and invalidating `/index.html` rolls the SPA back (hashed assets from both
  versions coexist).
- **Terraform changes to the task definition** (env vars, sizing) are applied with
  `make plan && make apply` and reach the running service on the next deploy, or
  immediately with `--force-new-deployment` after the pipeline has re-rendered the
  latest revision.

## 9. Incident quick reference

| Signal | First check | Likely cause |
|--------|-------------|--------------|
| `api-5xx` alarm | `/readyz` on a task, worker/api logs for `DEPENDENCY_UNAVAILABLE` | DynamoDB throttling, Redis down, bad deploy |
| `api-unhealthy-hosts` | ECS service events, task stopped reason | OOM (`memory`), crash loop, image pull failure |
| `api-latency-p95` | `/metrics` histogram, DynamoDB latency, Redis CPU | Hot partition, Redis saturation, CPU-bound replays |
| `events-dlq-not-empty` | §6 | Handler bug, malformed event |
| `events-oldest-message-age` | Worker task count and logs | Worker down or under-scaled |
| `redis-memory-high` | `INFO memory`, key count of ended events | Missing key expiry, unexpected growth |
| Many `422 SCORE_MISMATCH` | Client version in logs, engine fixtures | Client/server engine drift (should be caught by CI) or tampering |
| Many `409 VERSION_CONFLICT` | Which endpoints | Client retry storm on one player; usually benign |

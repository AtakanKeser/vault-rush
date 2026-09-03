# Vault Rush — Load Testing

Method and results for the API's hot paths. Scripts and the how-to are in
[`load-tests/k6/README.md`](../load-tests/k6/README.md); raw k6 output for every run
below is committed under [`load-tests/results/`](../load-tests/results/). Every number in
this document comes from a run reproducible from the recorded configuration; unmeasured
cells stay `TBD`.

## 1. Goals

- Establish a latency baseline per endpoint (p50/p95/p99) at a known concurrency, so
  regressions show up in later runs.
- Verify the thresholds the API is designed for: `p95 < 200 ms` on read paths
  (`leaderboard`, `events/current`, `profile`), `p95 < 300 ms` on `heists/start` and
  `heists/{runId}/finish`, error rate `< 1%`, and **zero score mismatches** between the
  bot's local replay and the server's replay.
- Find the first bottleneck when concurrency grows and record where it appears.

## 2. Tooling

- **k6 v2.2.0** (`brew install k6`), scripts in `load-tests/k6/`: `smoke.js`,
  `leaderboard.js`, `profile.js`, `heist-flow.js`.
- `heist-flow.js` is a full player journey. Each virtual user creates a player, starts a
  heist, **plays it with the real deterministic engine** (`lib/engine.js` is bundled from
  `client/src/engine` by `npm run build:k6`; `lib/bot.js` is a greedy chain bot with
  cautious / balanced / reckless archetypes), submits the replay with an
  `Idempotency-Key`, re-sends it to assert `Idempotent-Replayed: true` with an identical
  body, and claims the reward. `score_mismatch` counts any run where the server's score
  differs from the bot's — it must be 0.
- Each VU is one player: it creates its own player (`POST /v1/player`) and uses the
  bearer token, so the per-player rate limit and per-player DynamoDB partitions behave as
  they would with real users.
- `handleSummary` writes `<script>-summary.json` to `RESULTS_DIR` and prints p50/p95/p99
  and the error rate.
- CI: `.github/workflows/load-test.yml` runs any script against a `base_url` on demand and
  uploads the JSON.

## 3. Environments

**A. Local, in-memory adapters** — the Go process alone.

| Item | Value |
|------|-------|
| Machine | Apple M1 Pro, 10 cores, 16 GB RAM, macOS 26.5 |
| API config | `STORAGE=memory CACHE=memory QUEUE=inline`, `RATE_LIMIT_PER_MIN=100`, `TELEMETRY_WORKERS=8`, `TELEMETRY_BUFFER=1000`, Go 1.27.1 |
| k6 host | same machine (loopback) |

**B. Local compose** — the full stack in Docker Desktop.

| Item | Value |
|------|-------|
| Machine | as above; Docker 29.5.3, VM with 10 CPUs / 7.75 GB |
| API config | `STORAGE=dynamodb CACHE=redis QUEUE=sqs`, `RATE_LIMIT_PER_MIN=600`, `TELEMETRY_WORKERS=8`, `TELEMETRY_BUFFER=1000` |
| Dependencies | `redis:7-alpine`, `amazon/dynamodb-local:2.5.2` (in-memory, shared DB), `softwaremill/elasticmq-native:1.6.11` — all containers on the same VM |
| Worker | one `worker` container consuming the queue (2 pollers, 8 sink goroutines) |
| k6 host | same machine (loopback → Docker port forwarding) |

**C. AWS (Terraform `prod` sizing)** — not measured in this version.

| Item | Value |
|------|-------|
| API tasks / Redis / region / k6 location | TBD |

Loopback numbers measure the API process and its containers, not the network. Environment
A isolates the Go code; environment B adds the SDK round-trips and two single-JVM
emulators (DynamoDB Local, ElasticMQ) that behave nothing like their AWS counterparts
under load. Both are regression baselines, not production latencies.

## 4. Procedure

1. `smoke.js` against the target; all checks must pass before anything else is measured.
2. `RATE_LIMIT_PER_MIN` high enough that the limiter is not the subject (the compose
   stack uses 600; a heist iteration is 5 requests per fresh player).
3. 60 s at the target VU count with the script's default `SLEEP=1.5`.
4. Sample `docker stats --no-stream` three times during a run to attribute saturation.
5. Save the summary and the text output under `load-tests/results/<date>-<env>-<script>-<vus>vu.txt`.

Exact commands used (from `load-tests/k6/`):

```bash
k6 run -e BASE_URL=http://localhost:8090 -e VUS=200 -e DURATION=60s leaderboard.js   # env A
k6 run -e BASE_URL=http://localhost:8090 -e VUS=100 -e DURATION=60s heist-flow.js    # env A
k6 run -e BASE_URL=http://localhost:8095 -e VUS=200 -e DURATION=60s leaderboard.js   # env B
k6 run -e BASE_URL=http://localhost:8095 -e VUS=200 -e DURATION=60s profile.js       # env B
k6 run -e BASE_URL=http://localhost:8095 -e VUS=25  -e DURATION=60s heist-flow.js    # env B
k6 run -e BASE_URL=http://localhost:8095 -e VUS=100 -e DURATION=60s heist-flow.js    # env B
```

## 5. Results (2026-09-07)

### 5.1 Read paths

| Env | Script | Endpoint | VUs | Requests | req/s | p50 ms | p95 ms | p99 ms | Error % | Thresholds |
|-----|--------|----------|-----|----------|-------|--------|--------|--------|---------|------------|
| A | leaderboard.js | `GET /v1/leaderboard/global` | 200 | 16,200 (both endpoints) | 268.7 | 1.09 | 10.75 | 20.10 | 0.00 | all pass |
| A | leaderboard.js | `GET /v1/events/current` | 200 | ″ | ″ | 0.91 | 8.06 | 12.74 | 0.00 | all pass |
| B | leaderboard.js | `GET /v1/leaderboard/global` | 200 | 16,116 (both endpoints) | 262.3 | 4.01 | 28.93 | 90.32 | 0.00 | all pass |
| B | leaderboard.js | `GET /v1/events/current` | 200 | ″ | ″ | 2.74 | 15.42 | 43.51 | 0.00 | all pass |
| B | profile.js | `GET /v1/player/profile` | 200 | 8,200 | 134.2 | 5.47 | 53.46 | 158.03 | 0.00 | all pass |

The overall p99 of the env-B leaderboard run (368 ms) is dominated by the 200 simultaneous
`POST /v1/player` calls in the first second (each is a DynamoDB transaction); the
per-endpoint rows above are the steady-state reads.

### 5.2 Heist flow

`heist-flow.js`, 60 s, `SLEEP=1.5`. Requests per iteration: player, start, finish,
idempotent finish replay, claim.

| Env | VUs | Requests | req/s | start p50 / p95 / p99 ms | finish p50 / p95 / p99 ms | claim p95 ms | Error % | Score mismatches | Thresholds |
|-----|-----|----------|-------|--------------------------|---------------------------|--------------|---------|------------------|------------|
| A | 100 | 19,570 | 318.6 | 0.22 / 11.30 / 282.74 | 0.38 / 7.75 / 24.45 | 5.83 | 0.00 | 0 | all pass |
| B | 25 | 4,475 | 72.7 | 43.8 / 154.3 / 206.2 | 53.1 / 139.5 / 173.8 | 81.9 | 0.00 | 0 | all pass |
| B | 100 | 11,175 | 182.2 | 360.1 / 852.9 / 1,310.5 | 420.2 / 914.5 / 1,170.5 | 493.7 | 0.00 | 0 | `p(95)<300` **failed** for start and finish |

Every one of the 43,054 (A) and 24,585 (B) checks passed: the server reproduced the bot's
score on every run, the idempotent re-send returned the identical body with
`Idempotent-Replayed: true`, and no reward was paid twice.

### 5.3 Saturation

| Env | Script | Last passing VUs | First failing VUs | Failing threshold | What saturated | Evidence |
|-----|--------|------------------|-------------------|-------------------|----------------|----------|
| A | heist-flow.js | 100 | not reached | — | — | p95 7.8 ms at 100 VUs, 318 req/s |
| B | heist-flow.js | 25 | 100 | start/finish `p(95)<300 ms` | DynamoDB Local and ElasticMQ JVMs (each ≥ 1 core); API ≈ 1 core; Redis idle | `docker stats` sampled three times during a 100-VU run: `dynamodb` 65–120 %, `elasticmq` 98–121 %, `api` 59–96 %, `worker` 37–43 %, `redis` 4–8 % of one CPU |

Reading: at 100 VUs the compose stack pushes ~180 req/s through two single-JVM emulators
that AWS replaces with horizontally scaled services. The Go API itself never exceeded one
core. The flow that takes 420 ms (p50) against DynamoDB Local takes 0.38 ms against the
in-memory adapters, so the cost is in the SDK round-trips and the emulators, not in the
replay or the handlers. Two round-trips were already removed from `finish` during this
work (conditional reward `Create`, single-`UpdateItem` idempotency completion); the next
step is batching SQS publishes (`SendMessageBatch`, 10 per call), which would take most of
the load off ElasticMQ.

### 5.4 Telemetry pipeline under load

From `/metrics` on the API and the worker at the end of the env-B 100-VU heist run.

| Env | Script | VUs | queueDepth (end) | published | processed by worker | dropped | retries | failed |
|-----|--------|-----|------------------|-----------|---------------------|---------|---------|--------|
| B | heist-flow.js | 100 | 0 | 14,599 | 14,599 | 0 | 0 | 0 |
| A | heist-flow.js + leaderboard.js | 100 / 200 | 0 | 27,467 | 27,467 (in-process) | 0 | 0 | 0 |

The bounded channel never filled and every event reached its sinks; the SQS hop kept up
with ~240 events/s.

## 6. Interpreting results

- **p50 vs p95 gap** on loopback is GC pauses plus, in env B, DynamoDB Local's JVM; on AWS
  it is network plus DynamoDB tail latency. A large p99 with a small p95 usually points to
  a dependency, not the API.
- **Error rate above 0 with 429s** means the rate limiter, not the server — re-run with a
  higher `RATE_LIMIT_PER_MIN` or a longer `SLEEP`.
- **`telemetry.dropped > 0`** during a run is a valid finding: it means the channel filled
  at that concurrency. Note the VU count at which it starts.
- **Autoscaling** in environment C needs several minutes to react; a 60 s run measures the
  pre-scaled fleet. For scaling behaviour, run 10 minutes and record task count over time.

## 7. Open items

- Measure environment C (AWS) from a runner in the same region and fill §3/§5.
- Batch SQS publishes and re-run the env-B 100-VU heist test.
- Add a mixed scenario (many reads per finish) that reflects real traffic shape.

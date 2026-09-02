# k6 load tests

Scripts targeting the Vault Rush API. Method, machine specs and the results that count are
in [`docs/load-testing.md`](../../docs/load-testing.md); this file is the how-to.

## Scripts

| Script            | What it measures                                                    | Default thresholds                          |
|-------------------|----------------------------------------------------------------------|---------------------------------------------|
| `smoke.js`        | 1 VU, 1 iteration: healthz, readyz, player, profile, events, leaderboard, rewards, catalog | all checks pass, zero failed requests |
| `leaderboard.js`  | `GET /v1/leaderboard/global` + `GET /v1/events/current` per iteration | `http_req_failed<1%`, `p(95)<200ms`          |
| `profile.js`      | `GET /v1/player/profile` — cheapest authenticated request            | `http_req_failed<1%`, `p(95)<200ms`          |
| `heist-flow.js`   | Full player journey: create player → `POST /v1/heists/start` → **play the run locally with the real engine** (`lib/engine.js` bundled from `client/src/engine`, greedy bot in `lib/bot.js`) → `POST /v1/heists/{runId}/finish` with an `Idempotency-Key` → resend to assert `Idempotent-Replayed: true` → claim the reward. Asserts the server score equals the bot's score on every run (`score_mismatch==0`) | `http_req_failed<1%`, start/finish `p(95)<300ms`, `score_mismatch==0` |

Every VU creates its own player (`POST /v1/player` with a random `deviceId`) and uses the
returned bearer token. Shared code lives in `lib/common.js` (config, player creation) and
`lib/summary.js` (`handleSummary`).

## Running

Install k6 (`brew install k6`), then from this directory:

```sh
k6 run -e BASE_URL=http://localhost:8080 smoke.js
k6 run -e BASE_URL=http://localhost:8080 -e VUS=200 -e DURATION=60s leaderboard.js
k6 run -e BASE_URL=http://localhost:8080 -e VUS=200 -e DURATION=60s profile.js
k6 run -e BASE_URL=http://localhost:8080 -e VUS=20 -e ITERATIONS=3 heist-flow.js
```

| Variable      | Default                  | Notes                                                                  |
|---------------|--------------------------|------------------------------------------------------------------------|
| `BASE_URL`    | `http://localhost:8080`  | API base URL, no trailing slash needed                                 |
| `VUS`         | `10`                     | Virtual users (= concurrent players)                                   |
| `DURATION`    | `30s`                    | Test length (`maxDuration` for `heist-flow.js`)                        |
| `SLEEP`       | `1.5`                    | Seconds each VU pauses between iterations                              |
| `ITERATIONS`  | `1`                      | `heist-flow.js` only: heists started per VU                            |
| `RESULTS_DIR` | `../results`             | Where `<script>-summary.json` is written (relative to the current dir) |

### Rate limiting

The API enforces 100 requests / minute / player. With the default `SLEEP=1.5`,
`leaderboard.js` issues about 80 requests per minute per VU, safely under the limit. If
you lower `SLEEP` or the goal is to find the server's ceiling rather than a single player's,
start the API with a higher `RATE_LIMIT_PER_MIN`; otherwise the 429s show up as failed
requests and the `http_req_failed` threshold trips for the wrong reason.

### Output

Each run prints a text report:

```
Vault Rush load test - leaderboard
  base_url    http://localhost:8080
  vus         200    duration 60s    sleep 1.5s
  requests    ...    throughput ... req/s
  error rate  ...% (... failed / ...)
  latency ms  p50 ...   p95 ...   p99 ...   max ...
  per endpoint (ms):
    GET /v1/leaderboard/global       p50 ...  p95 ...  p99 ...  max ...
    GET /v1/events/current           p50 ...  p95 ...  p99 ...  max ...
  thresholds:
    PASS  http_req_failed: rate<0.01
    ...
```

and writes the full k6 summary to `load-tests/results/<script>-summary.json` (git-ignored).
k6 exits non-zero when a threshold fails.

### Validating scripts without a server

```sh
for s in smoke leaderboard profile heist-flow; do k6 inspect "$s.js" >/dev/null && echo "$s ok"; done
```

### From GitHub Actions

`.github/workflows/load-test.yml` runs any of these scripts against a `base_url` input
(manual trigger) and uploads the summary JSON as an artifact.

## Results template

Copy this into `docs/load-testing.md` for every measured configuration. Never record numbers
without the machine/deployment specs next to them.

| Date | Script | Target (deployment, sizing) | VUs | Duration | Requests | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | Error rate | Thresholds |
|------|--------|-----------------------------|-----|----------|----------|--------------------|----------|----------|----------|------------|------------|
| TBD  | leaderboard.js | TBD                 | TBD | TBD      | TBD      | TBD                | TBD      | TBD      | TBD      | TBD        | TBD        |
| TBD  | profile.js     | TBD                 | TBD | TBD      | TBD      | TBD                | TBD      | TBD      | TBD      | TBD        | TBD        |
| TBD  | heist-flow.js  | TBD                 | TBD | TBD      | TBD      | TBD                | TBD      | TBD      | TBD      | TBD        | TBD        |

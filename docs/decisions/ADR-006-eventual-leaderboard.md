# ADR-006: Eventual consistency between runs (DynamoDB) and the leaderboard (Redis)

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

A finished run is settled in DynamoDB (run status, reward, profile stats); its score
must also appear in the Redis sorted set (ADR-003). Two different systems cannot be
updated atomically. I had to decide which one is the truth, what happens when the
second write fails, and what the player sees in between.

## Decision

- DynamoDB is the source of truth. The conditional `ACTIVE → FINISHED` update on the
  `RUN#` item is the settlement point; a run is "finished" if and only if that item says
  so. The reward (`PutItem`, id derived from the run id) and the profile stats
  (`UpdateItem` with a version condition) follow it; each is idempotent, so a retry with
  the same `Idempotency-Key` completes whatever remained.
- The leaderboard is **never written on the request path**. After settlement the handler
  publishes a `RunFinished` event on the telemetry bus (a non-blocking channel send) and
  returns. The pipeline's leaderboard sink performs `ZADD lb:{eventId} GT score` — in
  process with `QUEUE=inline`, or in the worker binary after an SQS hop with `QUEUE=sqs`.
- The sink is retried with exponential backoff (5 attempts). In SQS mode a message whose
  sinks keep failing becomes visible again and moves to the dead-letter queue after 5
  receives; `operations.md` §6 describes replaying the DLQ, which is the recovery path
  after a Redis outage.
- The response to `finish` carries the authoritative score and profile, so the player's
  own result is immediate and consistent regardless of Redis.
- Leaderboard reads never fall back to DynamoDB. If Redis is down the endpoint returns
  `503 DEPENDENCY_UNAVAILABLE` and the client shows the board it last saw.

## Consequences

Positive:

- The finish path has one commit point and a simple failure story; no dual-write
  anomaly can show a score for a run that was not settled, which is the failure mode of
  writing Redis first.
- Request latency does not include Redis at all. Measured locally, `finish` p95 stays in
  single-digit milliseconds against the in-memory adapters and low tens of milliseconds
  against DynamoDB Local + Redis in Docker (`docs/load-testing.md`).
- `ZADD GT` (keep best) makes every delivery idempotent, so at-least-once SQS delivery and
  DLQ replays are harmless.
- The lag is normally sub-millisecond in inline mode and a queue hop (well under a
  second) in SQS mode; the client polls its rank for a moment on the result screen and
  says "rankings are updating" until it appears.

Negative:

- After a Redis outage longer than the retry window, scores land in the DLQ and are only
  ranked after an operator replays it. A backfill job that rebuilds a sorted set from
  `RUN#` items is the obvious follow-up (it needs a filtered `Scan`, which is why the
  worker task role — and only that role — is allowed to `Scan`); it is not implemented
  in this version.
- Best-score semantics are baked into the write. Cumulative scoring would need
  `ZINCRBY` and exactly-once delivery (or deduplication by event id), which this design
  does not provide.
- Reads returning 503 rather than a stale DynamoDB-derived board is a deliberate trade:
  a wrong board is worse than a missing one for a competitive feature, but it makes Redis
  availability user-visible.

## Alternatives considered

- **Synchronous `ZADD` in the request** — simplest, and what I started from. Rejected
  because it couples gameplay latency and error handling to Redis for a derived value,
  and because the pipeline already existed for analytics: one asynchronous path with one
  retry policy is easier to reason about than two.
- **Redis first, then DynamoDB** — the leaderboard could show scores for runs that never
  settled. Rejected outright.
- **Transactional outbox** — write the leaderboard update as a DynamoDB item in the same
  conditional write and have the worker apply it. Strictly more durable than a bounded
  in-memory channel (events accepted right before a crash can be lost in inline mode).
  Not chosen for the MVP; in SQS mode the queue already provides durability from the
  publish onwards, and the outbox is the upgrade path if inline drops ever matter.
- **DynamoDB Streams → Lambda → Redis** — same durability as the outbox with more
  infrastructure. Rejected for the same reason.
- **Strong consistency by serving ranks from DynamoDB** — no ranking primitive
  (ADR-003). Rejected.

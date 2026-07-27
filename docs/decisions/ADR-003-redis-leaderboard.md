# ADR-003: Redis sorted sets for the leaderboard

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

Every player sees a global leaderboard for the daily event (top 100), their own rank
(`me`), and a "rivals" view of the players immediately above and below them. The
leaderboard changes on every finished run and is read on every home-screen load, so it
is both write-heavy and the most-read thing in the game. Ranking is inherently a global
operation: a player's rank depends on everyone else's score.

DynamoDB (ADR-002) has no primitive for "position of this key in score order".
Emulating it means either reading every higher score (unbounded) or maintaining a
separate ordered structure by hand.

## Decision

Each event's leaderboard is a Redis sorted set, `lb:{eventId}`, with `score` as the
sorted-set score and `playerId` as the member.

- `finish` writes `ZADD lb:{eventId} GT score playerId` after the DynamoDB commit: a
  player's entry is their best score in the event (the `GT` flag keeps the maximum).
- Top 100: `ZREVRANGE lb:{eventId} 0 99 WITHSCORES`. Rank: `ZREVRANK`. Rivals:
  `ZREVRANGE` around the caller's rank. Total: `ZCARD`. All O(log N) or O(log N + M).
- Display names are resolved from a small Redis hash cache, falling back to DynamoDB.
- The set is derived state: it is written by the telemetry pipeline after the run is
  settled, every write is idempotent (`GT`), and it could be rebuilt from `RUN#` items
  by a backfill job (ADR-006 lists that as a follow-up). Keys expire 14 days after the
  last write.
- The ElastiCache parameter group uses `maxmemory-policy noeviction`: a full Redis fails
  writes loudly rather than silently evicting a ranking.

## Consequences

Positive:

- Rank, top-N and neighbourhood queries are single round-trips with logarithmic cost at
  any leaderboard size the game could reach.
- The write path adds one command after the commit; it does not affect the correctness
  of the finish transaction.
- ElastiCache single-node is enough: one event's sorted set is one key and cannot be
  sharded anyway; vertical scaling is the right knob.
- Redis was needed regardless for the per-player rate limiter and the config cache, so
  the leaderboard does not add a dependency, only a use.

Negative:

- The leaderboard is eventually consistent with DynamoDB (ADR-006). A Redis outage
  makes ranks stale or missing until the retried writes (or a DLQ replay) land; players
  still see their own score from the response.
- Best-score semantics are baked into the write (`GT`). Switching to cumulative scoring
  would be a one-line change (`ZINCRBY`) but would also require deduplicating redelivered
  events, which `GT` makes unnecessary today.
- Memory is the constraint: each member costs on the order of a hundred bytes, so even a
  million players per event fits comfortably in the smallest node — but `noeviction`
  means growth must be watched (alarm at 80%).
- Names are cached separately, so a renamed player can show the old name on the board
  until the cache entry is refreshed.

## Alternatives considered

- **DynamoDB GSI keyed by `(eventId, score)`** — gives top-N with a descending `Query`
  but not rank: computing "my position" means counting all items above me. Rejected.
- **Periodic materialisation** — a job computes ranks every minute and writes them back.
  Simple, but a one-minute-stale rank after finishing a run feels broken in a game whose
  loop is "beat your rivals". Rejected for the MVP; it would be the fallback if Redis
  became a cost problem.
- **PostgreSQL window functions** — exact and simple (`RANK() OVER (ORDER BY score DESC)`)
  but recomputed per request; would have pushed me toward PostgreSQL as the primary
  store, which I rejected in ADR-002.
- **In-process leaderboard** — fastest, but not shared across API tasks and lost on
  every deploy. Only viable with a single task, which the autoscaling design rules out.

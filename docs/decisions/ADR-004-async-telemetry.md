# ADR-004: Asynchronous telemetry via a bounded channel, worker pool and SQS

- **Status:** Accepted
- **Date:** 2026-06-21

## Context

LiveOps needs analytics: runs started and completed per event, vault drop-off, booster
usage, experiment group comparisons. These derive from gameplay events emitted by the
API. The events are valuable but not critical — a missing analytics event is a slightly
wrong chart; a slow or failed `finish` is a player losing a run. Under a traffic spike I
want the request path to stay fast and the analytics to degrade, not the other way
round.

Delivery to SQS costs a network round-trip with its own failure modes. Doing it inline in
the handler would add that latency and coupling to every gameplay request.

## Decision

Two-stage asynchronous pipeline (`docs/architecture.md` §3):

1. **In-process:** handlers call `Publish(event)`, which performs a non-blocking send on
   a bounded channel (`TELEMETRY_BUFFER`, default 1000). If the channel is full, the
   event is dropped and a `dropped` counter increments. A fixed pool of goroutines
   (`TELEMETRY_WORKERS`, default 8) drains the channel and delivers each event to
   every sink (analytics counters, leaderboard, or the SQS publisher) with exponential
   backoff — 5 attempts, 50 ms base, 5 s cap; a `Permanent` error is not retried.
2. **Out-of-process:** SQS (`vault-rush-events`) carries events to the worker binary,
   which applies the same sinks (analytics counters, `ZADD GT` on the leaderboard). A
   dead-letter queue receives messages that fail five times. `QUEUE=inline` swaps SQS for a direct
   in-process call to the same handlers for local development and tests.

On shutdown the channel is closed and the workers flush what remains, within a deadline
that fits the container's `stopTimeout`.

## Consequences

Positive:

- Request latency is independent of SQS latency and availability. The `Publish` cost is
  a channel send.
- Back-pressure has a defined, observable behaviour: drop and count. The counter is
  exposed on `/metrics` and `/admin/v1/system`, so "we lost 0.3% of events during the
  spike at 20:00" is a fact rather than a guess.
- The worker pool bounds concurrency toward SQS (no goroutine-per-event explosion) and
  batches up to 10 messages per request, which is also the cheapest way to use SQS.
- SQS decouples the API's and the worker's deploy and scaling cycles; the worker scales
  on queue depth.
- The same handler code runs inline locally, so the analytics path is covered by unit
  and integration tests without a queue.

Negative:

- Events can be lost, by design, in two places: a full channel (dropped) and a task
  killed before the flush completes (SIGKILL after `stopTimeout`). The first is counted;
  the second is not, and is bounded only by the shutdown budget. This is acceptable for
  analytics and would be unacceptable for anything money-related — rewards and purchases
  are therefore committed in DynamoDB inside the request, never via this pipeline.
- At-least-once delivery from SQS means the worker's aggregate updates must be
  idempotent (event ids), which is more code than a naive counter increment.
- Two moving parts (pool + queue) is more to reason about and monitor than a synchronous
  call. The metrics exist because of that.
- Ordering is not guaranteed across workers or across SQS standard-queue deliveries.
  Aggregates are commutative, so this does not matter here; it would for a stateful
  consumer.

## Alternatives considered

- **Synchronous `SendMessage` in the handler** — simplest, strongest delivery, but adds a
  network hop and a failure mode to every gameplay request. Rejected.
- **Blocking send on the channel** — never drops, but a stalled sink would eventually
  stall every request. Rejected; a game API should shed analytics before it sheds
  players.
- **Unbounded channel / goroutine per event** — hides the problem until memory runs out.
  Rejected.
- **Kinesis / Kafka (MSK)** — ordered, replayable streams. Over-engineered for counters
  at this scale and costly to run idle. SQS with a DLQ is the right size; a stream can
  replace the SQS stage later without touching the API's publish side.
- **Write analytics directly to DynamoDB from the API** — no queue, but puts aggregate
  write contention on the request path and couples the API to the analytics schema.

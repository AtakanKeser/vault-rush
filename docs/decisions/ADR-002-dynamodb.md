# ADR-002: DynamoDB single table instead of PostgreSQL

- **Status:** Accepted
- **Date:** 2026-06-09

## Context

The persistent data is small in variety and entirely keyed by an owner: a player's
profile, runs and rewards; an event's metadata and config versions; device lookups;
idempotency records. Every request touches one player or one event. There are no joins
in the request path, no ad-hoc reporting queries against live data (analytics are
aggregated by the worker), and traffic is spiky: a daily event reset produces a burst of
`start` calls, evenings produce a burst of `finish` calls, nights are nearly idle.

I also need conditional writes for two correctness properties: optimistic concurrency on
the profile (`version`) and exactly-once reward claims (`PENDING → CLAIMED`).

## Decision

One DynamoDB table (`vault_rush`) in single-table design: `PK`/`SK` string keys with
entity prefixes (`PLAYER#`, `EVENT#`, `DEVICE#`, `IDEMP#`), one GSI (`GSI1`) for listing
events by date, on-demand billing, TTL for idempotency records, point-in-time recovery.
Locally, DynamoDB Local behind the same `STORAGE=dynamodb` switch, plus an in-memory
implementation for unit tests.

## Consequences

Positive:

- Every access pattern in `docs/architecture.md` §5 is a `GetItem` or a single-partition
  `Query`. The finish commit (run + profile + reward) is one `TransactWriteItems` on one
  partition key.
- Conditional expressions give me optimistic concurrency and exactly-once claims without
  locks or a serializable isolation level.
- On-demand capacity absorbs the daily spikes with nothing to tune and costs nothing
  while idle, which suits a portfolio project that is mostly idle.
- No connection pool to size, no failover to orchestrate, no schema migrations to run
  during deploys. The Terraform for the table is thirty lines.
- Single-table design forces the access patterns to be written down before the code,
  which is the discipline I wanted to show.

Negative:

- No ad-hoc queries. "How many players busted on vault 3 today" is not a query, it is
  an aggregate the worker must maintain from the event stream. If a new question comes up
  after the fact, the answer is a Scan or a re-processing job. I accepted this because
  the analytics questions are known (the admin's analytics endpoint) and the event
  stream exists anyway.
- Leaderboard ranking does not fit: DynamoDB cannot answer "what is my rank" without
  reading everything above me. That is why Redis sorted sets exist (ADR-003), which is a
  second store I would not have needed with PostgreSQL window functions — at least at MVP
  scale.
- Local development needs an emulator (DynamoDB Local) and the CI integration job runs
  against it; behaviour differences from the real service (TTL sweeps, transaction
  limits) can hide until production.
- Key design changes are migrations without tooling. The zero-padded `CONFIG#00017` sort
  key is an example of a decision that is cheap now and painful to change later.
- Honest assessment: at the traffic this project will actually see, a single PostgreSQL
  instance would have been simpler and just as fast. I chose DynamoDB because the design
  scales without redesign and because it is the store the target role uses.

## Alternatives considered

- **PostgreSQL (RDS)** — relational model, ad-hoc SQL, window functions for ranking,
  transactions across entities. Rejected for the operational surface (instance sizing,
  connection pooling from many Fargate tasks, failover, migrations) relative to the
  benefit, given that the access patterns are fixed and key-value shaped.
- **DynamoDB with one table per entity** — simpler to read, but the finish transaction
  would span tables and the admin's player view would need several requests. Single
  table keeps everything a player owns in one partition.
- **Redis as the primary store** — fast and already present, but durability guarantees
  and cost per GB are wrong for the source of truth. Redis stays a derived view.

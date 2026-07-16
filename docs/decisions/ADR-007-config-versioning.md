# ADR-007: Immutable event config versions pinned per run

- **Status:** Accepted
- **Date:** 2026-07-16

## Context

The daily event's tuning (vault move budgets, objective counts, tile weights, difficulty,
loot multiplier) is edited by LiveOps while the event is live, from the admin dashboard.
Runs last minutes and thousands may be in flight when a change lands. Because the server
validates a run by replaying it (ADR-005), the replay must use exactly the config the
client used; otherwise every honest player mid-run would fail with `INVALID_REPLAY` or
`SCORE_MISMATCH` the moment an operator saved a change.

Operators also need to know what was changed, when, by whom and why — a balance change
that tanks completion rate has to be traceable and reversible.

## Decision

- Event config is versioned and immutable. `PUT /admin/v1/events/{id}/config` writes a
  new item `EVENT#<id> / CONFIG#<version+1>` (zero-padded, so versions sort as strings)
  and advances the `configVersion` pointer on `EVENT#<id> / META`. Nothing is ever
  overwritten or deleted.
- Each version records `createdAt`, `createdBy` and a free-text `note`.
- `POST /v1/heists/start` reads the current pointer, copies `configVersion` into the run
  item, and returns the full config to the client.
- `POST /v1/heists/{runId}/finish` loads `CONFIG#<run.configVersion>` — never "current" —
  and replays against it.
- `GET /admin/v1/events/{id}` returns the version history; any version can be fetched by
  number. Rolling back is "create a new version with the old values", which keeps the
  history linear.

## Consequences

Positive:

- Config changes are safe at any time. In-flight runs finish against their pinned
  version; new runs pick up the new one. There is no "maintenance window" concept.
- Full audit trail for free, which the admin dashboard shows next to the analytics so
  a change can be correlated with a shift in completion rate.
- Immutable versions are perfectly cacheable: the API caches `(eventId, version)` in
  Redis and in memory without invalidation logic. Only the small `META` pointer needs a
  short TTL.
- The analytics can be sliced by config version later (every `run_started` event
  carries it), which is the honest way to evaluate a balance change.

Negative:

- Storage grows with every edit. Configs are a few kilobytes and edits are a handful per
  day, so this is negligible, but there is no cleanup and none is planned.
- The `finish` path performs an extra lookup for a config that is not the current one
  if the operator changed it mid-run. It is a cache hit in practice.
- Operators cannot "fix" a version in place, even for a typo in the note. That is the
  point, but it surprises people used to mutable settings pages.
- The leaderboard mixes scores achieved under different versions of the same event. If
  a change makes an event much easier, earlier players are disadvantaged. I accept this
  for a daily event; it is the operator's responsibility (and the analytics' job to show)
  when a change is unfair enough to warrant a new event instead.

## Alternatives considered

- **Mutable config, reject edits while runs are active** — there are always active runs
  in a live event. Unworkable.
- **Mutable config, tolerate mismatches** — accept a replay that fails against the
  current config if it passes against the previous one. Fragile, and it weakens the
  anti-cheat guarantee. Rejected.
- **Send the full config with the finish request** — the server would have to trust or
  re-validate it; the whole point is that the server knows the config. Rejected.
- **Version by timestamp instead of a counter** — works, but a counter is human-readable
  in the admin ("v17 → v18") and trivially sortable with zero padding.

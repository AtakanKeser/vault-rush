# Vault Rush — API Reference

Base URL (local): `http://localhost:8080`

All responses are JSON. Errors use a single shape:

```json
{ "error": { "code": "RUN_NOT_FOUND", "message": "run does not exist" } }
```

| HTTP | Code                    | When                                                        |
|------|-------------------------|-------------------------------------------------------------|
| 400  | `BAD_REQUEST`           | malformed JSON / missing field                              |
| 401  | `UNAUTHORIZED`          | missing or invalid bearer token                             |
| 403  | `FORBIDDEN`             | run belongs to another player / admin token invalid         |
| 404  | `RUN_NOT_FOUND`, `EVENT_NOT_FOUND`, `REWARD_NOT_FOUND`, `PLAYER_NOT_FOUND` |
| 409  | `RUN_ALREADY_FINISHED`, `REWARD_ALREADY_CLAIMED`, `VERSION_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS` |
| 410  | `RUN_EXPIRED`, `EVENT_CLOSED`                               |
| 402  | `INSUFFICIENT_COINS`, `INSUFFICIENT_LIVES`, `INSUFFICIENT_BOOSTERS` |
| 422  | `INVALID_REPLAY`, `SCORE_MISMATCH`, `IMPLAUSIBLE_RESULT`    |
| 429  | `RATE_LIMITED`                                              |
| 503  | `DEPENDENCY_UNAVAILABLE`                                    |

Every response carries `X-Request-Id`. Every request may carry `X-Request-Id` to propagate tracing.

---

## Authentication

Players authenticate with a bearer token returned by `POST /v1/player`.

```
Authorization: Bearer <token>
```

Admin endpoints require:

```
X-Admin-Token: <ADMIN_TOKEN env>
```

Rate limit: token bucket, `100 requests / minute / player` (configurable). Exceeding returns `429` with `Retry-After`.

---

## Player

### `POST /v1/player`
Create (or resume) a player for a device. Idempotent per `deviceId`.

Request
```json
{ "deviceId": "ios-3F2A...", "displayName": "Atakan" }
```
Response `201` (or `200` when resumed)
```json
{
  "playerId": "plr_01J7...",
  "token": "eyJ...",
  "profile": { ...Profile }
}
```

### `GET /v1/player/profile`
```json
{
  "playerId": "plr_01J7...",
  "displayName": "Atakan",
  "coins": 1250,
  "lives": 4,
  "maxLives": 5,
  "nextLifeAt": "2026-09-07T13:20:00Z",
  "boosters": { "extra_moves": 2, "shield": 0 },
  "stats": { "runs": 12, "bestScore": 18420, "totalLoot": 91200, "vaultsCracked": 31 },
  "experimentGroup": "A",
  "version": 17,
  "createdAt": "..."
}
```

`version` is the optimistic-concurrency counter. Every mutation of the profile performs `UPDATE ... WHERE version = :expected`; a lost race yields `409 VERSION_CONFLICT` and the client should refetch and retry.

---

## Events (Daily Global Heist)

### `GET /v1/events/current`
```json
{
  "event": {
    "eventId": "louvre_2026_09_07",
    "name": "Louvre Diamond Heist",
    "theme": "louvre",
    "status": "ACTIVE",
    "startsAt": "2026-09-07T00:00:00Z",
    "endsAt": "2026-09-08T00:00:00Z",
    "configVersion": 17
  },
  "config": { ...EventConfig },
  "leaderboardPreview": [ { "rank": 1, "playerId": "...", "name": "Atakan", "score": 182450 } ],
  "me": { "rank": 41, "score": 12440 }
}
```

`EventConfig` (see `docs/engine.md` for the semantics):
```json
{
  "eventId": "louvre_2026_09_07",
  "version": 17,
  "seed": 82938122,
  "difficulty": 1.0,
  "lootMultiplier": 1.0,
  "livesCost": 1,
  "grid": { "w": 7, "h": 7 },
  "vaultMultipliers": [1, 1.5, 2, 3, 5],
  "bustPenalty": 0.5,
  "vaults": [
    {
      "name": "Lobby Safe",
      "moves": 18,
      "objectives": { "key": 8, "laser": 0, "camera": 0 },
      "locks": 0,
      "weights": { "key": 20, "laser": 16, "camera": 16, "money": 20, "diamond": 10, "guard": 12 }
    }
  ],
  "createdAt": "...",
  "createdBy": "admin",
  "note": "Vault 4 too hard, lowered lasers"
}
```

---

## Heists (runs)

### `POST /v1/heists/start`
Costs `livesCost` lives. Consumes selected boosters from inventory.

Request
```json
{ "boosters": ["extra_moves"] }
```
Response `201`
```json
{
  "runId": "run_7fd12",
  "playerId": "plr_...",
  "eventId": "louvre_2026_09_07",
  "seed": 82938122,
  "configVersion": 17,
  "boosters": ["extra_moves"],
  "startedAt": "...",
  "expiresAt": "...",
  "config": { ...EventConfig }
}
```

The server stores only `{runId, playerId, eventId, seed, configVersion, boosters, status, startedAt, expiresAt}`. The board is reproduced deterministically by both client and server from `seed + config` (see `docs/engine.md`).

### `POST /v1/heists/{runId}/finish`
Headers: `Idempotency-Key: <uuid>` (recommended). Replaying the same key returns the original response with `Idempotent-Replayed: true`.

Request
```json
{
  "vaults": [
    { "moves": [[0, 1, 2], [10, 17, 24, 31]] },
    { "moves": [[3, 4, 11]] }
  ],
  "escaped": true,
  "clientScore": 18420,
  "durationMs": 82142
}
```

Validation chain (in order):
1. run exists → `404 RUN_NOT_FOUND`
2. run belongs to caller → `403 FORBIDDEN`
3. not already finished → `409 RUN_ALREADY_FINISHED`
4. not expired → `410 RUN_EXPIRED`
5. replay is structurally valid & every move legal → `422 INVALID_REPLAY`
6. replayed score == `clientScore` → `422 SCORE_MISMATCH`
7. plausibility bounds (duration, move count) → `422 IMPLAUSIBLE_RESULT`

Response `200`
```json
{
  "runId": "run_7fd12",
  "outcome": "ESCAPED",
  "score": 18420,
  "loot": 9210,
  "vaultReached": 4,
  "vaultsCracked": 3,
  "multiplier": 2.0,
  "reward": { "rewardId": "rwd_...", "type": "RUN_LOOT", "coins": 184, "status": "PENDING" },
  "profile": { ...Profile }
}
```

`outcome` ∈ `ESCAPED | BUSTED`.

---

## Leaderboard

### `GET /v1/leaderboard/global?eventId=<id>&limit=100`
`eventId` defaults to the current event.
```json
{
  "eventId": "louvre_2026_09_07",
  "total": 14282,
  "entries": [ { "rank": 1, "playerId": "plr_...", "name": "Atakan", "score": 182450 } ],
  "me": { "rank": 41, "score": 12440 }
}
```

### `GET /v1/leaderboard/friends?eventId=<id>`
Same shape. MVP semantics: the 5 players above and below the caller ("rivals"); a real friends graph is a follow-up.

---

## Rewards

### `GET /v1/rewards`
```json
{ "rewards": [ { "rewardId": "rwd_...", "type": "RUN_LOOT", "coins": 184, "status": "PENDING", "createdAt": "..." } ] }
```

### `POST /v1/rewards/claim`
Exactly-once: a conditional write flips `PENDING → CLAIMED`; concurrent claims lose with `409 REWARD_ALREADY_CLAIMED`.
```json
{ "rewardId": "rwd_..." }
```
Response
```json
{ "rewardId": "rwd_...", "coins": 184, "status": "CLAIMED", "profile": { ...Profile } }
```

---

## Shop

### `GET /v1/shop/catalog`
```json
{ "items": [ { "itemId": "extra_moves", "name": "Extra Moves", "description": "+3 moves in every vault", "price": 300 },
             { "itemId": "shield", "name": "Shield", "description": "Bust penalty halved", "price": 450 },
             { "itemId": "life", "name": "Life", "description": "Refill one life", "price": 200 } ] }
```

### `POST /v1/shop/purchase`
```json
{ "itemId": "extra_moves" }
```
Response: `{ "profile": { ...Profile } }`. Errors: `402 INSUFFICIENT_COINS`, `409 VERSION_CONFLICT` (retry).

---

## Ops

- `GET /healthz` → `{"status":"ok"}` (liveness)
- `GET /readyz` → `{"status":"ok","deps":{"redis":"ok","dynamodb":"ok","queue":"ok"}}` (readiness, 503 when degraded)
- `GET /metrics` → JSON counters: requests, latency histogram, telemetry queue depth/dropped, sink retries.

---

## Admin (LiveOps) — `X-Admin-Token`

### `GET /admin/v1/events?window=7`
Events for yesterday, today and the next `window` days (auto-provisioned on read).
```json
{ "events": [ { "eventId": "...", "name": "...", "theme": "...", "status": "ACTIVE|UPCOMING|ENDED", "startsAt": "...", "endsAt": "...", "configVersion": 17 } ] }
```

### `GET /admin/v1/events/{eventId}`
```json
{ "event": { ...EventMeta }, "config": { ...EventConfig }, "versions": [ { "version": 17, "createdAt": "...", "createdBy": "admin", "note": "..." } ] }
```

### `GET /admin/v1/events/{eventId}/config/{version}` → `{ "config": { ...EventConfig } }`

### `PUT /admin/v1/events/{eventId}/config`
Creates a **new** version (never overwrites). Active runs keep the version they started with.
```json
{ "config": { ...EventConfig fields (version ignored) }, "note": "Vault 4 too hard", "createdBy": "atakan" }
```
Response `201`: `{ "event": {...}, "config": {...version: 18} }`

### `POST /admin/v1/events`
```json
{ "eventId": "special_2026_09_10", "name": "...", "theme": "louvre", "startsAt": "...", "endsAt": "...", "config": { ... } }
```

### `GET /admin/v1/events/{eventId}/analytics`
```json
{
  "eventId": "louvre_2026_09_07",
  "players": 14282,
  "runsStarted": 51492,
  "runsCompleted": 31822,
  "completionRate": 0.618,
  "escaped": 20144,
  "busted": 11678,
  "avgVault": 3.4,
  "avgScore": 12441,
  "vaultReached": { "1": 51492, "2": 42223, "3": 31410, "4": 19052, "5": 9268 },
  "vaultDropoff": [ { "vault": 1, "reached": 51492, "pct": 1.0 }, { "vault": 2, "reached": 42223, "pct": 0.82 } ],
  "boostersUsed": { "extra_moves": 1200, "shield": 340 },
  "rewardsClaimed": 30110,
  "experiments": {
    "lives_test": {
      "A": { "players": 7100, "runsStarted": 25000, "runsCompleted": 15200, "runsPerUser": 3.5, "completionRate": 0.61 },
      "B": { "players": 7182, "runsStarted": 26492, "runsCompleted": 16622, "runsPerUser": 3.7, "completionRate": 0.63 }
    }
  }
}
```

### `GET /admin/v1/experiments`
```json
{ "experiments": [ { "id": "lives_test", "description": "Max lives 5 vs 7", "groups": { "A": { "maxLives": 5 }, "B": { "maxLives": 7 } }, "assignment": "fnv1a(playerId) % 2" } ] }
```

### `GET /admin/v1/players/{playerId}` → `{ "profile": {...}, "runs": [ ...last 20 runs ] }`
### `POST /admin/v1/players/{playerId}/grant` `{ "coins": 500, "lives": 1, "boosters": {"shield": 1} }` → `{ "profile": {...} }`

### `GET /admin/v1/system`
```json
{
  "version": "0.1.0",
  "uptimeSeconds": 1234,
  "storage": "dynamodb|memory",
  "cache": "redis|memory",
  "queue": "sqs|inline",
  "telemetry": { "queueDepth": 3, "capacity": 1000, "workers": 8, "processed": 51201, "dropped": 0, "retries": 4 },
  "deps": { "redis": "ok", "dynamodb": "ok", "queue": "ok" }
}
```

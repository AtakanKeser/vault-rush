# Vault Rush — LiveOps Admin Panel

Internal operations console for the Vault Rush daily heist events. Talks only to the
`/admin/v1/*` endpoints plus `GET /healthz`, `GET /readyz` and `GET /metrics`
described in [`docs/api.md`](../docs/api.md).

Stack: Vite · React 18 · TypeScript · react-router-dom · plain CSS (design tokens in
`src/styles.css`). No UI kit, no chart library — charts are hand-written HTML/SVG.

## Run it

```bash
cd admin
npm install

# Terminal 1 — zero-dependency mock of the admin API on :8080
npm run mock

# Terminal 2 — Vite dev server on :3000 (proxies /admin, /healthz, /readyz, /metrics → :8080)
npm run dev
```

Open <http://localhost:3000>, paste the admin token (`local-admin-token` for the mock /
local backend) and press **Connect**. The token is validated against `/admin/v1/system`,
stored in `localStorage` as `vr_admin_token`, and sent as `X-Admin-Token` on every
request. Any `401`/`403` from an admin endpoint clears it and returns you to the
Connect screen.

Other scripts:

| Script              | What it does                                                   |
|---------------------|----------------------------------------------------------------|
| `npm run build`     | `tsc --noEmit` + production bundle to `dist/`                  |
| `npm run preview`   | Serve the production bundle                                    |
| `npm run typecheck` | TypeScript only                                                |
| `npm run mock`      | Mock API (`mock/server.mjs`), see below                        |

## Configuration

| Variable            | Where        | Default                 | Purpose                                                        |
|---------------------|--------------|-------------------------|----------------------------------------------------------------|
| `VITE_API_URL`      | build / dev  | `""` (same origin)      | Base URL of the Go API. Leave empty to use the dev proxy.      |
| `ADMIN_PORT`        | dev / preview| `3000`                  | Vite port (handy when 3000 is taken).                          |
| `VITE_PROXY_TARGET` | dev          | `http://localhost:8080` | Where the dev proxy forwards API calls.                        |
| `PORT`              | mock         | `8080`                  | Mock server port.                                              |
| `ADMIN_TOKEN`       | mock         | `local-admin-token`     | Token the mock accepts.                                        |

Example when the default ports are occupied on your machine:

```bash
PORT=8089 npm run mock
ADMIN_PORT=3100 VITE_PROXY_TARGET=http://localhost:8089 npm run dev
```

Copy `.env.example` to `.env.local` to persist `VITE_API_URL`.

## Screens

| Route            | Screen                                                                                                  |
|------------------|---------------------------------------------------------------------------------------------------------|
| `/`              | **Overview** — KPI tiles for the current event, vault drop-off bars, A/B table, live system strip (10s) |
| `/events`        | **Events** — yesterday / today / upcoming with status, times, countdown and config version              |
| `/events/:id`    | **Event detail** — header + countdown, config editor with diff-confirm publish, version history (view / restore), event-scoped analytics |
| `/players[/:id]` | **Players** — profile, boosters, stats, last 20 runs, grant form                                          |
| `/experiments`   | **Experiments** — group definitions + per-group performance in the current event                       |
| `/system`        | **System** — `/admin/v1/system`, `/healthz`, `/readyz`, `/metrics` (latency histogram, counters, generic table for unknown keys) |

Publishing a config calls `PUT /admin/v1/events/{id}/config` and always creates a **new**
version; the toast reminds you that active runs keep the previous version. "Restore" on an
older version loads its fields into the editor so you can review the diff and publish it
as a new version — nothing is ever overwritten.

## Mock server

`mock/server.mjs` is a dependency-free Node HTTP server that implements every admin
endpoint with the exact JSON shapes from `docs/api.md`:

- Events for yesterday, today and the next `window` days are provisioned on read; today's
  event ships with 17 config versions so the history/diff UI has something to show.
- `PUT /admin/v1/events/{id}/config` validates the payload and appends a new version in
  memory (lost on restart).
- Analytics are deterministic per event (seeded RNG) and scale with how far into the day
  the active event is.
- Players: `plr_01J7ATAKAN0001`, `plr_01J7MIRA00002`, `plr_01J7KENJI00003`,
  `plr_01J7SOFIA00004`, `plr_01J7DIEGO00005` are named; any other `plr_*` id gets a
  deterministic synthetic profile; anything else is `404 PLAYER_NOT_FOUND`.
- Grants mutate the in-memory profile and bump `version`.
- `/metrics` exposes request counters, a latency histogram (`latency.buckets[{le,count}]`)
  and telemetry stats; ~100–250 ms of artificial latency makes loading states visible.

## Project layout

```
admin/
  index.html            Inter font, favicon, root
  vite.config.ts        port + proxy (env-overridable)
  mock/server.mjs       mock API
  src/
    api/                types.ts (mirrors docs/api.md), client.ts (fetch + token), hooks.ts (useAsync)
    components/         Layout, ui primitives, Analytics charts, ConfigEditor, VersionHistory, SystemStrip, Toast, Modal, Icons
    pages/              Connect, Overview, Events, EventDetail, Players, Experiments, System
    utils/              format.ts, diff.ts (config diff for the publish confirmation)
    styles.css          design tokens + all component styles
```

## Screenshots

_Coming soon — drop PNGs into `admin/docs/` and reference them here._

- Overview
- Event detail (editor + version history)
- Publish confirmation diff
- Players
- System

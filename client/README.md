# Vault Rush — game client

Vite + TypeScript, no framework. The board is an HTML5 Canvas; screens are plain DOM.
The client contains a **TypeScript port of the deterministic engine** and is kept
bit-identical to the Go engine by golden fixtures (`src/engine/fixtures.json`, generated
by `make fixtures` at the repo root).

```bash
npm install
VITE_API_URL=http://localhost:8080 npm run dev   # http://localhost:5173
npm test            # engine golden fixtures + RNG reference values (Vitest)
npm run typecheck
npm run build       # dist/ (≈70 KB JS, 26 KB CSS before gzip)
npm run build:k6    # bundles the engine for the k6 heist bot (load-tests/k6/lib/engine.js)
```

## Layout

| Path | What |
|---|---|
| `src/engine/` | `rng.ts` (mulberry32), `engine.ts` (Sim, replay, scoring), fixtures + tests |
| `src/game/board.ts` | Canvas renderer, drag-to-chain input, pop → gravity → settle animation |
| `src/game/tiles.ts` | Hand-drawn SVG tile art rendered to sprites |
| `src/game/fx.ts` | Tweens, particles, floating labels |
| `src/game/audio.ts` | Procedural WebAudio sounds (muted state persisted) |
| `src/ui/screens.ts` | Welcome, Home, Play HUD, decision modal, Result, Leaderboard, Shop |
| `src/main.ts` | State machine: boot → home → play → result; run persistence and resume |
| `src/api.ts` | Typed API client, device/token storage, idempotency keys |

## How a run works

1. `POST /v1/heists/start` returns `{seed, config, boosters}`; the client builds vault 1
   with `new Sim(new RNG(seed), config, 0, boosters)`.
2. Every chain is applied locally; the moves are persisted to `localStorage` after each
   one so an interrupted heist can be resumed from the home screen.
3. Cracking a vault opens the escape / go-deeper decision; going deeper continues the
   same RNG stream into the next vault.
4. On escape or bust the client computes its own score with `runReplay` and submits
   `{vaults, escaped, clientScore, durationMs}` with an `Idempotency-Key`. The server's
   replay is authoritative; the result screen shows the server's numbers.

In dev builds `window.__vr` exposes the state and board for automation (used by the
headless screenshot scripts); it is stripped from production builds.

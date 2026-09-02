// Greedy heist bot for load tests. Uses the deterministic engine bundle
// (lib/engine.js, generated from client/src/engine) so every replay it
// produces is legal and scores exactly like the server will.
//
// Strategy per move: longest legal chain (DFS, capped) of an objective tile
// while objectives remain; otherwise guards when moves are low; otherwise the
// longest chain of anything. Mirrors backend/pkg/engine/bot.go closely enough
// to produce realistic funnels (cautious / balanced / reckless archetypes).

import { RNG, Sim, runReplay } from './engine.js';

const LOCK = 6;
const EMPTY = -1;

export function longestChain(sim, kinds, maxLen) {
  const cells = sim.w * sim.h;
  const visited = new Array(cells).fill(false);
  let best = [];
  const path = [];
  const dfs = (idx, t) => {
    path.push(idx);
    visited[idx] = true;
    if (path.length >= 3 && path.length > best.length) best = path.slice();
    if (path.length < maxLen) {
      const r = Math.floor(idx / sim.w);
      const c = idx % sim.w;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= sim.h || cc < 0 || cc >= sim.w) continue;
          const ni = rr * sim.w + cc;
          if (!visited[ni] && sim.grid[ni] === t) dfs(ni, t);
        }
      }
    }
    visited[idx] = false;
    path.pop();
  };
  for (let i = 0; i < cells && best.length < maxLen; i++) {
    const t = sim.grid[i];
    if (t === LOCK || t === EMPTY) continue;
    if (kinds && !kinds.includes(t)) continue;
    dfs(i, t);
  }
  return best.length >= 3 ? best : null;
}

export function chooseMove(sim, opts) {
  const maxLen = opts.maxChain || 6;
  if (opts.greedy && sim.movesLeft > 6) {
    const loot = longestChain(sim, [4, 3], maxLen);
    if (loot) return loot;
  }
  const needed = [];
  if (sim.objectives.key > 0) needed.push(0);
  if (sim.objectives.laser > 0) needed.push(1);
  if (sim.objectives.camera > 0) needed.push(2);
  if (needed.length) {
    const mv = longestChain(sim, needed, maxLen);
    if (mv) return mv;
  }
  if (sim.movesLeft <= 3) {
    const g = longestChain(sim, [5], maxLen);
    if (g) return g;
  }
  return longestChain(sim, null, maxLen);
}

/**
 * Plays a full heist. Returns { replay, result } where result is the local
 * (client-side) score the server must reproduce.
 */
export function playRun(config, seed, boosters, opts) {
  const maxVault = Math.max(1, Math.min(opts.maxVault || config.vaults.length, config.vaults.length));
  const rng = new RNG(seed);
  const vaults = [];
  let lastState = 'PLAYING';
  let moves = 0;
  for (let vi = 0; vi < maxVault; vi++) {
    const sim = new Sim(rng, config, vi, boosters);
    const vr = { moves: [] };
    while (sim.state === 'PLAYING') {
      const mv = chooseMove(sim, opts);
      if (!mv) break;
      sim.apply(mv);
      vr.moves.push(mv);
      moves++;
    }
    vaults.push(vr);
    lastState = sim.state;
    if (sim.state === 'BUSTED') break;
  }
  const replay = { vaults, escaped: lastState === 'CRACKED', clientScore: 0, durationMs: moves * 1500 + 2000 };
  const result = runReplay(config, seed, boosters, replay);
  replay.clientScore = result.score;
  return { replay, result };
}

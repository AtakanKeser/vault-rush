// GENERATED from client/src/engine by npm run build:k6 — do not edit.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/engine/rng.ts
var RNG = class {
  constructor(seed) {
    __publicField(this, "s");
    this.s = seed >>> 0;
  }
  next() {
    this.s = this.s + 1831565813 >>> 0;
    let t = this.s;
    t = Math.imul(t ^ t >>> 15, 1 | t) >>> 0;
    t = (t + Math.imul(t ^ t >>> 7, 61 | t) ^ t) >>> 0;
    return (t ^ t >>> 14) >>> 0;
  }
  nextInt(n) {
    if (n <= 0) throw new Error("engine: nextInt with n <= 0");
    return this.next() % n;
  }
  get state() {
    return this.s;
  }
};

// src/engine/engine.ts
var Tile = {
  Key: 0,
  Laser: 1,
  Camera: 2,
  Money: 3,
  Diamond: 4,
  Guard: 5,
  Lock: 6,
  Empty: -1
};
var TILE_NAMES = ["key", "laser", "camera", "money", "diamond", "guard", "lock"];
var BASE_LOOT = [40, 40, 40, 100, 250, 30, 0];
var BOOSTER_EXTRA_MOVES = "extra_moves";
var BOOSTER_SHIELD = "shield";
var EXTRA_MOVES_BONUS = 3;
function difficultyPct(difficulty) {
  return Math.floor(difficulty * 100 + 0.5);
}
function scaledObjectives(base, pct) {
  const scale = (v) => v === 0 ? 0 : Math.floor((v * pct + 50) / 100);
  return { key: scale(base.key), laser: scale(base.laser), camera: scale(base.camera) };
}
function chainPct(n) {
  if (n >= 6) return 300;
  if (n === 5) return 200;
  if (n === 4) return 150;
  return 100;
}
function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}
function weightsOrdered(w) {
  return [w.key, w.laser, w.camera, w.money, w.diamond, w.guard];
}
function weightsTotal(w) {
  return w.key + w.laser + w.camera + w.money + w.diamond + w.guard;
}
var Sim = class {
  constructor(rng, cfg, vaultIndex, boosters) {
    __publicField(this, "w");
    __publicField(this, "h");
    __publicField(this, "grid");
    __publicField(this, "vault");
    __publicField(this, "objectives");
    __publicField(this, "movesLeft");
    __publicField(this, "loot", 0);
    __publicField(this, "state", "PLAYING");
    __publicField(this, "reshuffles", 0);
    __publicField(this, "rng");
    __publicField(this, "weights");
    const v = cfg.vaults[vaultIndex];
    this.w = cfg.grid.w;
    this.h = cfg.grid.h;
    this.vault = v;
    this.objectives = scaledObjectives(v.objectives, difficultyPct(cfg.difficulty));
    this.movesLeft = v.moves + (boosters.includes(BOOSTER_EXTRA_MOVES) ? EXTRA_MOVES_BONUS : 0);
    this.rng = rng;
    this.weights = v.weights;
    this.grid = new Array(this.w * this.h).fill(Tile.Empty);
    this.generate();
  }
  randomTile() {
    const ordered = weightsOrdered(this.weights);
    let r = this.rng.nextInt(weightsTotal(this.weights));
    for (let t = 0; t < ordered.length; t++) {
      if (r < ordered[t]) return t;
      r -= ordered[t];
    }
    return Tile.Money;
  }
  generate() {
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = this.randomTile();
    let placed = 0;
    const cells = this.w * this.h;
    while (placed < this.vault.locks) {
      const idx = this.rng.nextInt(cells);
      if (this.grid[idx] !== Tile.Lock) {
        this.grid[idx] = Tile.Lock;
        placed++;
      }
    }
    if (!this.hasAnyMove()) this.reshuffle();
  }
  reshuffle() {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (let i = 0; i < this.grid.length; i++) {
        if (this.grid[i] !== Tile.Lock) this.grid[i] = this.randomTile();
      }
      this.reshuffles++;
      if (this.hasAnyMove()) return;
    }
  }
  hasAnyMove() {
    for (let r = 0; r < this.h; r++) {
      for (let c = 0; c < this.w; c++) {
        const t = this.grid[r * this.w + c];
        if (t === Tile.Lock || t === Tile.Empty) continue;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= this.h || cc < 0 || cc >= this.w) continue;
            if (this.grid[rr * this.w + cc] === t) n++;
          }
        }
        if (n >= 2) return true;
      }
    }
    return false;
  }
  /** Returns an error string, or null when the path is legal. */
  validatePath(path) {
    if (path.length < 3) return `chain length ${path.length} < 3`;
    const cells = this.w * this.h;
    const seen = /* @__PURE__ */ new Set();
    let first = -1;
    for (let i = 0; i < path.length; i++) {
      const idx = path[i];
      if (idx < 0 || idx >= cells) return `index ${idx} out of range`;
      if (seen.has(idx)) return `index ${idx} repeated`;
      seen.add(idx);
      const t = this.grid[idx];
      if (t === Tile.Lock || t === Tile.Empty) return `cell ${idx} is not chainable`;
      if (i === 0) first = t;
      else {
        if (t !== first) return "mixed tile types";
        const pr = Math.floor(path[i - 1] / this.w);
        const pc = path[i - 1] % this.w;
        const r = Math.floor(idx / this.w);
        const c = idx % this.w;
        if (Math.abs(pr - r) > 1 || Math.abs(pc - c) > 1) return `cells ${path[i - 1]} and ${idx} are not adjacent`;
      }
    }
    return null;
  }
  /** Whether `next` may be appended to the current chain (client input helper). */
  canExtend(path, next) {
    if (path.includes(next)) return false;
    const t = this.grid[next];
    if (t === Tile.Lock || t === Tile.Empty) return false;
    if (path.length === 0) return true;
    if (this.grid[path[0]] !== t) return false;
    const last = path[path.length - 1];
    const pr = Math.floor(last / this.w);
    const pc = last % this.w;
    const r = Math.floor(next / this.w);
    const c = next % this.w;
    return Math.abs(pr - r) <= 1 && Math.abs(pc - c) <= 1;
  }
  previewLoot(path) {
    if (path.length < 3) return 0;
    const t = this.grid[path[0]];
    return Math.floor(path.length * BASE_LOOT[t] * chainPct(path.length) / 100);
  }
  apply(path) {
    if (this.state !== "PLAYING") throw new Error(`invalid move: vault is ${this.state}`);
    const err = this.validatePath(path);
    if (err) throw new Error(`invalid move: ${err}`);
    const t = this.grid[path[0]];
    const n = path.length;
    const pct = chainPct(n);
    const loot = Math.floor(n * BASE_LOOT[t] * pct / 100);
    this.loot += loot;
    if (t === Tile.Key) this.objectives.key = Math.max(0, this.objectives.key - n);
    else if (t === Tile.Laser) this.objectives.laser = Math.max(0, this.objectives.laser - n);
    else if (t === Tile.Camera) this.objectives.camera = Math.max(0, this.objectives.camera - n);
    this.movesLeft--;
    let bonus = false;
    if (t === Tile.Guard) {
      this.movesLeft++;
      bonus = true;
    }
    const inPath = new Set(path);
    const unlocked = [];
    for (let idx = 0; idx < this.w * this.h; idx++) {
      if (this.grid[idx] !== Tile.Lock) continue;
      const r = Math.floor(idx / this.w);
      const c = idx % this.w;
      if (r > 0 && inPath.has(idx - this.w) || r < this.h - 1 && inPath.has(idx + this.w) || c > 0 && inPath.has(idx - 1) || c < this.w - 1 && inPath.has(idx + 1)) {
        this.grid[idx] = this.randomTile();
        unlocked.push(idx);
      }
    }
    for (const idx of path) this.grid[idx] = Tile.Empty;
    const gravity = this.collapseAndRefill();
    let reshuffled = false;
    if (this.objectives.key === 0 && this.objectives.laser === 0 && this.objectives.camera === 0) {
      this.state = "CRACKED";
    } else if (this.movesLeft <= 0) {
      this.state = "BUSTED";
    } else if (!this.hasAnyMove()) {
      this.reshuffle();
      reshuffled = true;
    }
    return {
      tile: t,
      length: n,
      pct,
      loot,
      bonusMove: bonus,
      unlocked,
      objectives: { ...this.objectives },
      state: this.state,
      gravity,
      reshuffled
    };
  }
  collapseAndRefill() {
    const report = [];
    for (let c = 0; c < this.w; c++) {
      const moved = [];
      let write = this.h - 1;
      for (let r = this.h - 1; r >= 0; r--) {
        if (this.grid[r * this.w + c] !== Tile.Empty) {
          if (write !== r) {
            this.grid[write * this.w + c] = this.grid[r * this.w + c];
            moved.push({ from: r, to: write });
          }
          write--;
        }
      }
      for (let r = 0; r <= write; r++) this.grid[r * this.w + c] = this.randomTile();
      report.push({ col: c, moved, spawned: write + 1 });
    }
    return report;
  }
};
function runReplay(cfg, seed, boosters, rep) {
  if (rep.vaults.length === 0) throw new Error("invalid replay: no vaults");
  if (rep.vaults.length > cfg.vaults.length) throw new Error("invalid replay: too many vaults");
  const rng = new RNG(seed);
  let totalLoot = 0;
  let last = null;
  let cracked = 0;
  let totalMoves = 0;
  for (let vi = 0; vi < rep.vaults.length; vi++) {
    const sim = new Sim(rng, cfg, vi, boosters);
    for (const mv of rep.vaults[vi].moves) {
      if (sim.state !== "PLAYING") throw new Error(`invalid replay: vault ${vi + 1} has moves after ${sim.state}`);
      sim.apply(mv);
      totalMoves++;
    }
    if (sim.state === "PLAYING") throw new Error(`invalid replay: vault ${vi + 1} unfinished`);
    if (sim.state === "BUSTED" && vi !== rep.vaults.length - 1) throw new Error("invalid replay: busted mid-run");
    if (sim.state === "CRACKED") cracked++;
    totalLoot += sim.loot;
    last = sim;
  }
  const reached = rep.vaults.length;
  if (last.state === "CRACKED") {
    if (!rep.escaped && reached < cfg.vaults.length) throw new Error("invalid replay: neither escaped nor continued");
    const mult2 = cfg.vaultMultipliers[reached - 1];
    return {
      outcome: "ESCAPED",
      score: roundHalfUp(totalLoot * mult2 * cfg.lootMultiplier),
      loot: totalLoot,
      vaultReached: reached,
      vaultsCracked: cracked,
      multiplier: mult2,
      totalMoves
    };
  }
  if (rep.escaped) throw new Error("invalid replay: escaped flag on a busted run");
  const mult = reached >= 2 ? cfg.vaultMultipliers[reached - 2] : 1;
  let penalty = cfg.bustPenalty;
  if (boosters.includes(BOOSTER_SHIELD)) penalty = penalty * 0.5;
  return {
    outcome: "BUSTED",
    score: roundHalfUp(totalLoot * mult * (1 - penalty) * cfg.lootMultiplier),
    loot: totalLoot,
    vaultReached: reached,
    vaultsCracked: cracked,
    multiplier: mult,
    totalMoves
  };
}
function escapeScore(cfg, totalLoot, vaultReached) {
  return roundHalfUp(totalLoot * cfg.vaultMultipliers[vaultReached - 1] * cfg.lootMultiplier);
}
function bustScore(cfg, totalLoot, vaultReached, boosters) {
  const mult = vaultReached >= 2 ? cfg.vaultMultipliers[vaultReached - 2] : 1;
  const penalty = cfg.bustPenalty * (boosters.includes(BOOSTER_SHIELD) ? 0.5 : 1);
  return roundHalfUp(totalLoot * mult * (1 - penalty) * cfg.lootMultiplier);
}
export {
  BASE_LOOT,
  BOOSTER_EXTRA_MOVES,
  BOOSTER_SHIELD,
  EXTRA_MOVES_BONUS,
  RNG,
  Sim,
  TILE_NAMES,
  Tile,
  bustScore,
  chainPct,
  difficultyPct,
  escapeScore,
  roundHalfUp,
  runReplay,
  scaledObjectives
};

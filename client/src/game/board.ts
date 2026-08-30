/**
 * Canvas board: renders the Sim, handles drag-to-chain input and plays the
 * pop → gravity → settle animation for every move. The engine owns the rules;
 * this file only owns pixels.
 */
import { Sim, Tile, type MoveResult } from '../engine/engine';
import { TILE_STYLE, tileImage } from './tiles';
import { Tweens, Particles, Floaters, ease, withAlpha } from './fx';
import { sound } from './audio';

export interface BoardCallbacks {
  onChain(path: number[], preview: number, tile: number): void;
  onMove(res: MoveResult, path: number[]): void;
  onSettled(res: MoveResult): void;
}

interface Cell {
  type: number;
  dy: number; // vertical offset in rows (negative = above resting place)
  scale: number;
  alpha: number;
  glow: number; // 0..1 highlight strength
}

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private sim: Sim | null = null;
  private cells: Cell[] = [];
  private w = 7;
  private h = 7;
  private size = 44;
  private gap = 6;
  private pad = 10;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private tweens = new Tweens();
  private particles = new Particles();
  private floaters = new Floaters();
  private path: number[] = [];
  private pointerId: number | null = null;
  private pointer: { x: number; y: number } | null = null;
  private shakeT = 0;
  private shakeAmp = 0;
  private flashColor = '';
  private flashA = 0;
  private hint = 0; // 0..1 hint pulse strength
  private ro: ResizeObserver;
  private destroyed = false;
  private idleT = 0;
  inputEnabled = true;
  animating = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: BoardCallbacks,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.style.touchAction = 'none';
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
  }

  setSim(sim: Sim, animateIn = true): void {
    this.sim = sim;
    this.w = sim.w;
    this.h = sim.h;
    this.path = [];
    this.tweens.clear();
    this.cells = sim.grid.map((t) => ({ type: t, dy: 0, scale: animateIn ? 0 : 1, alpha: 1, glow: 0 }));
    this.resize();
    if (animateIn) {
      for (let i = 0; i < this.cells.length; i++) {
        const r = Math.floor(i / this.w);
        const c = i % this.w;
        const cell = this.cells[i];
        cell.dy = -(this.h - r) - 1;
        this.tweens.add({
          from: cell.dy,
          to: 0,
          duration: 0.55,
          delay: 0.02 * c + 0.03 * (this.h - r),
          ease: ease.outBounce,
          onUpdate: (v) => {
            cell.dy = v;
            cell.scale = 1;
          },
        });
      }
      this.animating = true;
      this.inputEnabled = false;
      this.tweens.add({
        from: 0,
        to: 1,
        duration: 0.55 + 0.02 * this.w + 0.03 * this.h,
        onUpdate: () => {},
        onComplete: () => {
          this.animating = false;
          this.inputEnabled = sim.state === 'PLAYING';
        },
      });
    } else {
      this.inputEnabled = sim.state === 'PLAYING';
    }
  }

  showHint(on: boolean): void {
    this.hint = on ? 1 : 0;
  }

  /** Viewport (CSS px) center of a cell — used by automation and tutorials. */
  cellCenterCSS(idx: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const c = this.center(idx);
    return { x: rect.left + c.x, y: rect.top + c.y };
  }

  /** Longest legal chain up to maxLen, preferring the given tile kinds. */
  findChain(maxLen = 5, kinds?: number[]): number[] | null {
    const s = this.sim;
    if (!s) return null;
    let best: number[] = [];
    const visited = new Array<boolean>(s.grid.length).fill(false);
    const path: number[] = [];
    const dfs = (idx: number, t: number): void => {
      path.push(idx);
      visited[idx] = true;
      if (path.length >= 3 && path.length > best.length) best = [...path];
      if (path.length < maxLen) {
        const r = Math.floor(idx / s.w);
        const c = idx % s.w;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= s.h || cc < 0 || cc >= s.w) continue;
            const ni = rr * s.w + cc;
            if (!visited[ni] && s.grid[ni] === t) dfs(ni, t);
          }
      }
      visited[idx] = false;
      path.pop();
    };
    for (let i = 0; i < s.grid.length && best.length < maxLen; i++) {
      const t = s.grid[i];
      if (t === Tile.Lock || t === Tile.Empty) continue;
      if (kinds && !kinds.includes(t)) continue;
      dfs(i, t);
    }
    return best.length >= 3 ? best : null;
  }

  flash(color: string, alpha = 0.35): void {
    this.flashColor = color;
    this.flashA = alpha;
  }

  shake(amp = 6): void {
    this.shakeAmp = amp;
    this.shakeT = 0.4;
  }

  celebrate(): void {
    const colors = ['#F7C948', '#FFFFFF', '#8EE8FF', '#3DD68C', '#FF6B82'];
    for (let i = 0; i < 6; i++) {
      const x = this.pad + Math.random() * (this.cssW - this.pad * 2);
      const y = this.pad + Math.random() * (this.cssH - this.pad * 2);
      this.particles.burst(x, y, colors[i % colors.length], 18, { speed: 260, size: 5, ttl: 1.1, shape: 'square', gravity: 380 });
    }
  }

  // ---- layout ----

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.cssW = rect.width;
    this.pad = Math.round(rect.width * 0.03);
    this.gap = Math.max(4, Math.round(rect.width * 0.016));
    this.size = (rect.width - this.pad * 2 - this.gap * (this.w - 1)) / this.w;
    this.cssH = this.pad * 2 + this.size * this.h + this.gap * (this.h - 1);
    this.canvas.style.height = `${this.cssH}px`;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
  }

  private cellXY(idx: number): { x: number; y: number } {
    const r = Math.floor(idx / this.w);
    const c = idx % this.w;
    return { x: this.pad + c * (this.size + this.gap), y: this.pad + r * (this.size + this.gap) };
  }

  private center(idx: number): { x: number; y: number } {
    const p = this.cellXY(idx);
    const cell = this.cells[idx];
    return { x: p.x + this.size / 2, y: p.y + this.size / 2 + (cell ? cell.dy * (this.size + this.gap) : 0) };
  }

  private hit(px: number, py: number): number {
    const step = this.size + this.gap;
    const c = Math.floor((px - this.pad) / step);
    const r = Math.floor((py - this.pad) / step);
    if (c < 0 || c >= this.w || r < 0 || r >= this.h) return -1;
    const cx = this.pad + c * step + this.size / 2;
    const cy = this.pad + r * step + this.size / 2;
    const radius = this.size * 0.46;
    if (Math.hypot(px - cx, py - cy) > radius) return -1;
    return r * this.w + c;
  }

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- input ----

  private onDown = (e: PointerEvent): void => {
    if (!this.sim || !this.inputEnabled || this.animating || this.pointerId !== null) return;
    const p = this.toLocal(e);
    const idx = this.hit(p.x, p.y);
    if (idx < 0 || !this.sim.canExtend([], idx)) return;
    this.pointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointer = p;
    this.path = [idx];
    this.cells[idx].glow = 1;
    this.hint = 0;
    sound.tick(1);
    this.emitChain();
    e.preventDefault();
  };

  private onMove = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId || !this.sim) return;
    const p = this.toLocal(e);
    this.pointer = p;
    const idx = this.hit(p.x, p.y);
    if (idx < 0) return;
    const last = this.path[this.path.length - 1];
    if (idx === last) return;
    if (this.path.length >= 2 && idx === this.path[this.path.length - 2]) {
      const removed = this.path.pop()!;
      this.cells[removed].glow = 0;
      sound.tick(this.path.length);
      this.emitChain();
      return;
    }
    if (this.sim.canExtend(this.path, idx)) {
      this.path.push(idx);
      this.cells[idx].glow = 1;
      sound.tick(this.path.length);
      this.emitChain();
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.pointer = null;
    const path = this.path;
    this.path = [];
    for (const i of path) this.cells[i].glow = 0;
    this.cb.onChain([], 0, -1);
    if (path.length >= 3 && this.sim && this.sim.validatePath(path) === null) {
      this.commit(path);
    } else if (path.length > 0) {
      sound.tap();
    }
  };

  private emitChain(): void {
    if (!this.sim) return;
    const t = this.path.length ? this.sim.grid[this.path[0]] : -1;
    this.cb.onChain([...this.path], this.sim.previewLoot(this.path), t);
  }

  // ---- move animation ----

  private commit(path: number[]): void {
    const sim = this.sim!;
    const prevTypes = this.cells.map((c) => c.type);
    const res = sim.apply(path);
    this.cb.onMove(res, path);
    this.inputEnabled = false;
    this.animating = true;
    this.idleT = 0;

    const style = TILE_STYLE[res.tile];
    sound.collect(res.length);
    if (res.bonusMove) setTimeout(() => sound.bonus(), 120);
    if (res.unlocked.length) setTimeout(() => sound.unlock(), 180);

    // Phase A — pop the chain in order.
    const stagger = Math.min(0.03, 0.22 / path.length);
    let cx = 0;
    let cy = 0;
    path.forEach((idx, i) => {
      const cell = this.cells[idx];
      const c = this.center(idx);
      cx += c.x;
      cy += c.y;
      this.tweens.add({
        from: 1,
        to: 0,
        duration: 0.18,
        delay: i * stagger,
        ease: ease.inQuad,
        onUpdate: (v, t) => {
          cell.scale = t < 0.3 ? 1 + 0.25 * (t / 0.3) : 1.25 * v;
          cell.alpha = Math.min(1, v * 1.4);
        },
        onComplete: () => {
          this.particles.burst(c.x, c.y, style.glow, 7 + Math.min(6, res.length), { speed: 150 + res.length * 8, size: this.size * 0.09, ttl: 0.55 });
          if (res.length >= 5) this.particles.burst(c.x, c.y, '#FFFFFF', 4, { speed: 90, size: this.size * 0.06, ttl: 0.4, shape: 'spark' });
        },
      });
    });
    cx /= path.length;
    cy /= path.length;
    const popDur = 0.2 + stagger * path.length;
    const sub = res.pct > 100 ? `${res.length} CHAIN ×${(res.pct / 100).toFixed(res.pct % 100 ? 1 : 0)}` : undefined;
    this.floaters.add(cx, cy - this.size * 0.2, `+${res.loot.toLocaleString('en-US')}`, style.top, { sub, size: this.size * (res.pct >= 200 ? 0.62 : 0.5), ttl: 1.05 });
    if (res.bonusMove) this.floaters.add(cx, cy + this.size * 0.55, '+1 MOVE', '#C39BFF', { size: this.size * 0.36, ttl: 1.0 });
    if (res.length >= 6) this.shake(4);

    // Unlocked locks pop into their new type where they stand (before gravity).
    const finalIndex = (idx: number): number => {
      const r = Math.floor(idx / this.w);
      const c = idx % this.w;
      const col = res.gravity[c];
      const mv = col.moved.find((m) => m.from === r);
      return (mv ? mv.to : r) * this.w + c;
    };
    for (const idx of res.unlocked) {
      const cell = this.cells[idx];
      const newType = sim.grid[finalIndex(idx)];
      this.tweens.add({
        from: 0,
        to: 1,
        duration: 0.32,
        delay: popDur * 0.6,
        ease: ease.outBack,
        onUpdate: (v, t) => {
          if (t === 0 || cell.type === Tile.Lock) {
            cell.type = newType;
            const c = this.center(idx);
            this.particles.burst(c.x, c.y, '#D9DEE8', 10, { speed: 120, size: this.size * 0.07, ttl: 0.5, shape: 'square' });
          }
          cell.scale = v;
        },
      });
    }

    // Phase B — gravity.
    const gravityDelay = popDur + (res.unlocked.length ? 0.12 : 0);
    let longest = 0;
    this.tweens.add({
      from: 0,
      to: 1,
      duration: 0.001,
      delay: gravityDelay,
      onUpdate: () => {},
      onComplete: () => {
        const newCells: Cell[] = sim.grid.map((t) => ({ type: t, dy: 0, scale: 1, alpha: 1, glow: 0 }));
        for (const col of res.gravity) {
          for (const mv of col.moved) {
            const to = mv.to * this.w + col.col;
            newCells[to].dy = mv.from - mv.to; // negative: it comes from above
          }
          for (let r = 0; r < col.spawned; r++) {
            const idx = r * this.w + col.col;
            newCells[idx].dy = -(col.spawned - r) - 0.6;
          }
        }
        // Cells not touched keep prev visual type (identical to sim.grid anyway).
        for (let i = 0; i < newCells.length; i++) {
          if (newCells[i].dy === 0 && prevTypes[i] === newCells[i].type) newCells[i].scale = this.cells[i].scale || 1;
        }
        this.cells = newCells;
        for (let i = 0; i < newCells.length; i++) {
          const cell = newCells[i];
          if (cell.dy === 0) continue;
          const dist = -cell.dy;
          const dur = 0.32 + Math.min(0.35, dist * 0.06);
          longest = Math.max(longest, dur + (i % this.w) * 0.012);
          this.tweens.add({
            from: cell.dy,
            to: 0,
            duration: dur,
            delay: (i % this.w) * 0.012,
            ease: ease.outBounce,
            onUpdate: (v) => {
              cell.dy = v;
            },
          });
        }
        this.tweens.add({
          from: 0,
          to: 1,
          duration: Math.max(0.05, longest),
          onUpdate: () => {},
          onComplete: () => this.afterGravity(res),
        });
      },
    });
  }

  private afterGravity(res: MoveResult): void {
    const sim = this.sim!;
    const finish = () => {
      this.animating = false;
      this.inputEnabled = res.state === 'PLAYING';
      this.cb.onSettled(res);
    };
    if (res.reshuffled) {
      this.flash('#FFFFFF', 0.25);
      this.floaters.add(this.cssW / 2, this.cssH / 2, 'NO MOVES — RESHUFFLE', '#FFFFFF', { size: this.size * 0.42, ttl: 1.2 });
      sound.whoosh();
      this.cells.forEach((cell, i) => {
        this.tweens.add({
          from: 1,
          to: 0,
          duration: 0.18,
          delay: 0.2,
          onUpdate: (v) => (cell.scale = v),
          onComplete: () => {
            cell.type = sim.grid[i];
            this.tweens.add({ from: 0, to: 1, duration: 0.3, ease: ease.outBack, onUpdate: (v) => (cell.scale = v) });
          },
        });
      });
      this.tweens.add({ from: 0, to: 1, duration: 0.75, onUpdate: () => {}, onComplete: finish });
      return;
    }
    finish();
  }

  // ---- render loop ----

  private loop = (now: number): void => {
    if (this.destroyed) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.tweens.update(dt);
    this.particles.update(dt);
    this.floaters.update(dt);
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.flashA > 0) this.flashA = Math.max(0, this.flashA - dt * 1.4);
    if (this.inputEnabled && !this.animating && this.path.length === 0) this.idleT += dt;
    else this.idleT = 0;
    this.draw(now / 1000);
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(time: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (this.shakeT > 0) {
      const k = this.shakeT / 0.4;
      ctx.translate((Math.random() - 0.5) * this.shakeAmp * k, (Math.random() - 0.5) * this.shakeAmp * k);
    }

    // slots
    const rr = this.size * 0.24;
    for (let i = 0; i < this.w * this.h; i++) {
      const p = this.cellXY(i);
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      roundRect(ctx, p.x, p.y, this.size, this.size, rr);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (!this.sim) return;
    const inPath = new Set(this.path);
    const hintPulse = this.hint > 0 && this.idleT > 2.5 ? (Math.sin(time * 5) + 1) / 2 : 0;
    const hintIdx = hintPulse > 0 ? this.findHintChain() : null;

    // tiles (non-highlighted first so glowing ones render on top)
    const order = this.cells.map((_, i) => i).sort((a, b) => (inPath.has(a) ? 1 : 0) - (inPath.has(b) ? 1 : 0));
    for (const i of order) {
      const cell = this.cells[i];
      if (cell.type === Tile.Empty || cell.scale <= 0.01 || cell.alpha <= 0.01) continue;
      const p = this.cellXY(i);
      const y = p.y + cell.dy * (this.size + this.gap);
      const highlighted = inPath.has(i);
      const scale = cell.scale * (highlighted ? 1.12 : 1) * (hintIdx && hintIdx.includes(i) ? 1 + hintPulse * 0.06 : 1);
      this.drawTile(p.x, y, cell.type, scale, cell.alpha, highlighted, hintIdx && hintIdx.includes(i) ? hintPulse : 0);
    }

    // chain line
    if (this.path.length > 0) {
      const t = this.sim.grid[this.path[0]];
      const style = TILE_STYLE[t];
      const pts = this.path.map((i) => this.center(i));
      if (this.pointer && this.path.length >= 1) pts.push(this.pointer);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = this.size * 0.45;
      ctx.strokeStyle = withAlpha(style.glow, 0.9);
      ctx.lineWidth = this.size * 0.2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = this.size * 0.07;
      ctx.stroke();
      ctx.restore();
    }

    this.particles.draw(ctx);
    this.floaters.draw(ctx);

    if (this.flashA > 0) {
      ctx.fillStyle = this.flashColor;
      ctx.globalAlpha = this.flashA;
      ctx.fillRect(-20, -20, this.cssW + 40, this.cssH + 40);
      ctx.globalAlpha = 1;
    }
  }

  private findHintChain(): number[] | null {
    if (!this.sim) return null;
    // Cheap: first cell with ≥2 same neighbours, return it + two neighbours.
    const s = this.sim;
    for (let i = 0; i < s.grid.length; i++) {
      const t = s.grid[i];
      if (t === Tile.Lock || t === Tile.Empty) continue;
      const r = Math.floor(i / s.w);
      const c = i % s.w;
      const same: number[] = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= s.h || cc < 0 || cc >= s.w) continue;
          if (s.grid[rr * s.w + cc] === t) same.push(rr * s.w + cc);
        }
      if (same.length >= 2) return [same[0], i, same[1]];
    }
    return null;
  }

  private drawTile(x: number, y: number, type: number, scale: number, alpha: number, highlighted: boolean, hint: number): void {
    const ctx = this.ctx;
    const s = this.size;
    const style = TILE_STYLE[type] ?? TILE_STYLE[6];
    const cx = x + s / 2;
    const cy = y + s / 2;
    const size = s * scale;
    const left = cx - size / 2;
    const top = cy - size / 2;
    const rad = size * 0.24;
    ctx.save();
    ctx.globalAlpha = alpha;

    // drop shadow / glow
    ctx.shadowColor = highlighted ? style.glow : 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = highlighted ? size * 0.55 : size * 0.16;
    ctx.shadowOffsetY = highlighted ? 0 : size * 0.07;
    const grad = ctx.createLinearGradient(0, top, 0, top + size);
    grad.addColorStop(0, style.top);
    grad.addColorStop(1, style.bottom);
    ctx.fillStyle = grad;
    roundRect(ctx, left, top, size, size, rad);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // glossy highlight band
    ctx.save();
    roundRect(ctx, left, top, size, size, rad);
    ctx.clip();
    const gloss = ctx.createLinearGradient(0, top, 0, top + size * 0.55);
    gloss.addColorStop(0, 'rgba(255,255,255,0.28)');
    gloss.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = gloss;
    ctx.fillRect(left, top, size, size * 0.55);
    if (type === Tile.Lock) {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = size * 0.08;
      for (let k = -1; k < 3; k++) {
        ctx.beginPath();
        ctx.moveTo(left + k * size * 0.5, top + size);
        ctx.lineTo(left + k * size * 0.5 + size * 0.5, top);
        ctx.stroke();
      }
    }
    ctx.restore();

    // edge
    ctx.strokeStyle = highlighted ? 'rgba(255,255,255,0.9)' : withAlpha(style.edge, 0.55);
    ctx.lineWidth = highlighted ? Math.max(2, size * 0.06) : 1.25;
    roundRect(ctx, left, top, size, size, rad);
    ctx.stroke();
    if (hint > 0) {
      ctx.strokeStyle = `rgba(255,255,255,${0.35 * hint})`;
      ctx.lineWidth = size * 0.05;
      roundRect(ctx, left - 2, top - 2, size + 4, size + 4, rad + 2);
      ctx.stroke();
    }

    // icon
    const img = tileImage(type);
    if (img) {
      const is = size * 0.7;
      ctx.drawImage(img, cx - is / 2, cy - is / 2 + size * 0.01, is, is);
    }
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

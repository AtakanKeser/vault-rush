/** Tiny animation toolkit: tweens, particles, floating labels. */

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outBounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
};

export interface TweenSpec {
  from: number;
  to: number;
  duration: number;
  delay?: number;
  ease?: (t: number) => number;
  onUpdate: (v: number, t: number) => void;
  onComplete?: () => void;
}

interface Tween extends TweenSpec {
  elapsed: number;
  done: boolean;
}

export class Tweens {
  private list: Tween[] = [];

  add(spec: TweenSpec): void {
    this.list.push({ ...spec, elapsed: 0, done: false });
  }

  /** Resolves when the tween completes. */
  run(spec: Omit<TweenSpec, 'onComplete'>): Promise<void> {
    return new Promise((resolve) => this.add({ ...spec, onComplete: resolve }));
  }

  update(dt: number): void {
    for (const tw of this.list) {
      if (tw.done) continue;
      tw.elapsed += dt;
      const local = tw.elapsed - (tw.delay ?? 0);
      if (local < 0) continue;
      const t = Math.min(1, local / tw.duration);
      const e = (tw.ease ?? ease.outCubic)(t);
      tw.onUpdate(tw.from + (tw.to - tw.from) * e, t);
      if (t >= 1) {
        tw.done = true;
        tw.onComplete?.();
      }
    }
    if (this.list.length > 64) this.list = this.list.filter((t) => !t.done);
  }

  get active(): number {
    return this.list.filter((t) => !t.done).length;
  }

  clear(): void {
    this.list = [];
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  size: number;
  color: string;
  shape: 'dot' | 'spark' | 'square';
  rot: number;
  vr: number;
  gravity: number;
}

export class Particles {
  private list: Particle[] = [];

  burst(x: number, y: number, color: string, count: number, opts: { speed?: number; size?: number; ttl?: number; shape?: Particle['shape']; gravity?: number; spread?: number } = {}): void {
    const speed = opts.speed ?? 180;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.list.push({
        x: x + (Math.random() - 0.5) * (opts.spread ?? 6),
        y: y + (Math.random() - 0.5) * (opts.spread ?? 6),
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - speed * 0.3,
        life: 0,
        ttl: (opts.ttl ?? 0.6) * (0.7 + Math.random() * 0.6),
        size: (opts.size ?? 4) * (0.6 + Math.random() * 0.8),
        color,
        shape: opts.shape ?? (Math.random() < 0.3 ? 'spark' : 'dot'),
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 8,
        gravity: opts.gravity ?? 520,
      });
    }
  }

  update(dt: number): void {
    for (const p of this.list) {
      p.life += dt;
      p.vy += p.gravity * dt;
      p.vx *= 1 - 1.8 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.list = this.list.filter((p) => p.life < p.ttl);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.list) {
      const k = 1 - p.life / p.ttl;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.fillStyle = p.color;
      if (p.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.5 + k * 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.shape === 'square') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const s = p.size * (0.6 + k);
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.3, 0);
        ctx.lineTo(0, s);
        ctx.lineTo(-s * 0.3, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  get count(): number {
    return this.list.length;
  }
}

interface Floater {
  x: number;
  y: number;
  text: string;
  sub?: string;
  color: string;
  life: number;
  ttl: number;
  size: number;
}

export class Floaters {
  private list: Floater[] = [];

  add(x: number, y: number, text: string, color: string, opts: { sub?: string; size?: number; ttl?: number } = {}): void {
    this.list.push({ x, y, text, sub: opts.sub, color, life: 0, ttl: opts.ttl ?? 0.9, size: opts.size ?? 22 });
  }

  update(dt: number): void {
    for (const f of this.list) f.life += dt;
    this.list = this.list.filter((f) => f.life < f.ttl);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const f of this.list) {
      const t = f.life / f.ttl;
      const rise = ease.outCubic(Math.min(1, t * 1.4)) * 34;
      const pop = t < 0.15 ? ease.outBack(t / 0.15) : 1;
      const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(f.x, f.y - rise);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${f.size}px Fredoka, Nunito, system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(8,10,20,0.85)';
      ctx.strokeText(f.text, 0, 0);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);
      if (f.sub) {
        ctx.font = `700 ${f.size * 0.55}px Nunito, system-ui, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeText(f.sub, 0, f.size * 0.75);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(f.sub, 0, f.size * 0.75);
      }
      ctx.restore();
    }
  }
}

export function lerpColor(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function hex(c: string): [number, number, number] {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function withAlpha(c: string, a: number): string {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
}

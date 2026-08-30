/**
 * mulberry32 — bit-for-bit identical to backend/pkg/engine/rng.go.
 * All arithmetic is forced to unsigned 32-bit; never derive floats from it.
 */
export class RNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), 1 | t) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  nextInt(n: number): number {
    if (n <= 0) throw new Error('engine: nextInt with n <= 0');
    return this.next() % n;
  }

  get state(): number {
    return this.s;
  }
}

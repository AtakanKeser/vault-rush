/** Procedural sound: no assets, a few oscillators, muted by default preference. */

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted: boolean;

  constructor() {
    let m = false;
    try {
      m = localStorage.getItem('vr_muted') === '1';
    } catch {
      /* ignore */
    }
    this.muted = m;
  }

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.35;
        this.master.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem('vr_muted', this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (!this.muted) this.tick(3);
    return this.muted;
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.5, when = 0, slideTo?: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    const t0 = ctx.currentTime + when;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /** Chain selection tick; pitch rises with chain length. */
  tick(n: number): void {
    const f = 420 * Math.pow(1.0595, Math.min(n, 14) * 2);
    this.tone(f, 0.08, 'triangle', 0.35);
  }

  collect(n: number): void {
    const base = 520;
    const steps = Math.min(n, 8);
    for (let i = 0; i < steps; i++) this.tone(base * Math.pow(1.0595, i * 3), 0.12, 'triangle', 0.3, i * 0.035);
    this.tone(base * 2, 0.25, 'sine', 0.25, steps * 0.035);
  }

  unlock(): void {
    this.tone(300, 0.12, 'square', 0.15);
    this.tone(600, 0.2, 'triangle', 0.25, 0.08);
  }

  bonus(): void {
    this.tone(660, 0.1, 'triangle', 0.3);
    this.tone(880, 0.18, 'triangle', 0.3, 0.09);
  }

  crack(): void {
    const seq = [523, 659, 784, 1046];
    seq.forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.35, i * 0.11));
    this.tone(1568, 0.6, 'sine', 0.2, 0.44);
  }

  bust(): void {
    this.tone(220, 0.5, 'sawtooth', 0.25, 0, 90);
    this.tone(180, 0.6, 'square', 0.12, 0.1, 70);
  }

  coin(): void {
    this.tone(1200, 0.08, 'square', 0.15);
    this.tone(1800, 0.16, 'square', 0.15, 0.06);
  }

  tap(): void {
    this.tone(700, 0.05, 'sine', 0.2);
  }

  whoosh(): void {
    this.tone(200, 0.3, 'sine', 0.2, 0, 900);
  }
}

export const sound = new Sound();

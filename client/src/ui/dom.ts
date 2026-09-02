/** Minimal DOM helpers so the UI stays framework-free and readable. */

type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v as Record<string, string>);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v as Record<string, string>);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'K';
  return fmt(n);
}

export function multStr(m: number): string {
  return 'x' + (Number.isInteger(m) ? m.toString() : m.toFixed(1).replace(/\.0$/, ''));
}

export function countdown(target: Date, now = new Date()): string {
  let s = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  s -= mm * 60;
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(s)}`;
}

export function shortCountdown(target: Date, now = new Date()): string {
  const s = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/** Animate a number in an element from → to with easing. */
export function animateNumber(el: HTMLElement, from: number, to: number, duration = 900, format: (n: number) => string = fmt): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = format(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

export const icons = {
  heart: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 5 6.4 5c2 0 3.3 1.1 4.1 2.3C11.3 6.1 12.6 5 14.6 5 18 5 20.1 8.4 18.6 11.8 16.5 16.4 12 21 12 21z"/></svg>`,
  heartEmpty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 5 6.4 5c2 0 3.3 1.1 4.1 2.3C11.3 6.1 12.6 5 14.6 5 18 5 20.1 8.4 18.6 11.8 16.5 16.4 12 21 12 21z"/></svg>`,
  coin: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#F7C948"/><circle cx="12" cy="12" r="7.2" fill="none" stroke="#B8791A" stroke-width="1.6"/><text x="12" y="16" text-anchor="middle" font-family="Fredoka, sans-serif" font-weight="700" font-size="11" fill="#8A4F05">$</text></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h10v2h3v3a5 5 0 0 1-4.6 5 5 5 0 0 1-2.4 2.3V17h3v2H8v-2h3v-1.7A5 5 0 0 1 8.6 13 5 5 0 0 1 4 8V5h3V3zm-1 4v1a3 3 0 0 0 2.2 2.9A6 6 0 0 1 8 8.7V7H6zm12 0h-2v1.7a6 6 0 0 1-.2 2.2A3 3 0 0 0 18 8V7z"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z"/></svg>`,
  shop: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 7l1.5-4h13L20 7v2a3 3 0 0 1-2 2.8V21H6v-9.2A3 3 0 0 1 4 9V7zm5 7v5h6v-5H9z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zm-2.5-8v2.1a6 6 0 0 1 0 11.8V20a8 8 0 0 0 0-16z"/></svg>`,
  muted: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4zm12 .6L14.6 8l-1.4 1.4L15.6 12l-2.4 2.6 1.4 1.4L17 13.4l2.4 2.6 1.4-1.4L18.4 12l2.4-2.6L19.4 8z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.8"/><path d="M2 19a7 7 0 0 1 14 0zM15.5 19a5.5 5.5 0 0 1 6.5-5.4V19z"/></svg>`,
  moves: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h12M12 6l6 6-6 6"/></svg>`,
  vault: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 7v2M12 15v2M7 12h2M15 12h2"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1zm2 0h6V8a3 3 0 0 0-6 0v2z"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l10 18H2zm-1 7v5h2v-5zm0 6v2h2v-2z"/></svg>`,
};

export function svg(name: keyof typeof icons, cls = ''): HTMLElement {
  const span = h('span', { class: `ico ${cls}`.trim(), html: icons[name] });
  return span;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? 'A').toUpperCase();
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Screen builders. Pure functions from props → DOM; state lives in main.ts.
 */
import type { Board, CurrentEvent, LBEntry, Profile, Reward, ShopItem } from '../api';
import type { Objectives, Vault } from '../engine/engine';
import { TILE_STYLE, tileIconSVG } from '../game/tiles';
import { animateNumber, countdown, fmt, h, initials, multStr, ordinal, shortCountdown, svg } from './dom';

// ---------------------------------------------------------------- theme art

interface Theme {
  sky1: string;
  sky2: string;
  accent: string;
  stone: string;
  glow: string;
  dome: boolean;
  city: string;
}

const THEMES: Record<string, Theme> = {
  louvre: { sky1: '#1b2a6b', sky2: '#0b0e1a', accent: '#8ee8ff', stone: '#d8c9a3', glow: '#5aa9ff', dome: false, city: 'Paris' },
  met: { sky1: '#4a1b4f', sky2: '#0b0e1a', accent: '#ffb3c1', stone: '#e3d5c2', glow: '#ff6b82', dome: false, city: 'New York' },
  british: { sky1: '#12403a', sky2: '#0b0e1a', accent: '#a8f0cf', stone: '#cfd3d6', glow: '#3dd68c', dome: false, city: 'London' },
  prado: { sky1: '#5a1c1c', sky2: '#0b0e1a', accent: '#ffd36b', stone: '#e0b48a', glow: '#ff7d4d', dome: false, city: 'Madrid' },
  hermitage: { sky1: '#12354f', sky2: '#0b0e1a', accent: '#c6f0ff', stone: '#a9d3c6', glow: '#8ee8ff', dome: true, city: 'St. Petersburg' },
  uffizi: { sky1: '#5a3311', sky2: '#0b0e1a', accent: '#ffe08a', stone: '#e7c58f', glow: '#f7c948', dome: false, city: 'Florence' },
  vatican: { sky1: '#2c1b5a', sky2: '#0b0e1a', accent: '#f7c948', stone: '#e9dcc1', glow: '#c39bff', dome: true, city: 'Vatican City' },
};

export function themeOf(theme: string): Theme {
  return THEMES[theme] ?? THEMES.louvre;
}

function heroArt(t: Theme): string {
  const cols = [70, 110, 150, 250, 290, 330];
  const columns = cols
    .map(
      (x) => `<rect x="${x}" y="104" width="14" height="70" rx="3" fill="${t.stone}" opacity=".95"/>
<rect x="${x - 3}" y="100" width="20" height="7" rx="2" fill="${t.stone}"/>
<rect x="${x - 3}" y="171" width="20" height="6" rx="2" fill="${t.stone}"/>`,
    )
    .join('');
  const dome = t.dome
    ? `<path d="M140 92 Q200 40 260 92 Z" fill="${t.stone}" opacity=".9"/><rect x="196" y="30" width="8" height="16" rx="2" fill="${t.accent}"/>`
    : `<polygon points="40,96 200,44 360,96" fill="${t.stone}"/><polygon points="66,94 200,54 334,94" fill="${t.sky2}" opacity=".45"/>`;
  return `<svg viewBox="0 0 400 196" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.sky1}"/><stop offset="1" stop-color="${t.sky2}"/></linearGradient>
  <radialGradient id="gem" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
  <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.glow}" stop-opacity="0"/><stop offset="1" stop-color="${t.glow}" stop-opacity=".35"/></linearGradient>
  <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0e1a" stop-opacity="0"/><stop offset="1" stop-color="#07091a"/></linearGradient>
</defs>
<rect width="400" height="196" fill="url(#sky)"/>
<g fill="#fff" opacity=".8"><circle cx="40" cy="30" r="1.2"/><circle cx="90" cy="18" r=".9"/><circle cx="330" cy="26" r="1.1"/><circle cx="370" cy="60" r=".8"/><circle cx="250" cy="14" r="1"/><circle cx="20" cy="70" r=".7"/><circle cx="300" cy="50" r=".8"/></g>
<circle cx="330" cy="64" r="13" fill="#f4f0dc" opacity=".9"/><circle cx="324" cy="60" r="11.5" fill="url(#sky)" opacity=".92"/>
<polygon points="150,196 200,100 250,196" fill="url(#beam)"/>
<polygon points="60,196 200,100 340,196" fill="url(#beam)" opacity=".5"/>
<rect x="40" y="96" width="320" height="8" rx="2" fill="${t.stone}"/>
${dome}
${columns}
<rect x="176" y="118" width="48" height="60" rx="6" fill="#050612"/>
<rect x="30" y="176" width="340" height="10" rx="2" fill="${t.stone}" opacity=".9"/>
<rect x="20" y="186" width="360" height="10" rx="2" fill="${t.stone}" opacity=".6"/>
<circle cx="200" cy="146" r="34" fill="url(#gem)" opacity=".9"/>
<g transform="translate(200 146) scale(1.1)">
  <polygon points="-14,-6 -7,-16 7,-16 14,-6" fill="#fff"/>
  <polygon points="-14,-6 14,-6 0,16" fill="${t.accent}"/>
  <polygon points="-7,-16 0,-6 7,-16" fill="#eafbff"/>
  <polygon points="-14,-6 0,-6 0,16" fill="${t.glow}" opacity=".7"/>
</g>
<rect width="400" height="196" fill="url(#ground)" opacity=".8"/>
</svg>`;
}

// ---------------------------------------------------------------- tickers

export function tick(el: HTMLElement, fn: () => void, every = 1000): void {
  fn();
  const id = setInterval(() => {
    if (!el.isConnected) {
      clearInterval(id);
      return;
    }
    fn();
  }, every);
}

// ---------------------------------------------------------------- toast

export function toast(msg: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast toast--${kind}` }, msg);
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

// ---------------------------------------------------------------- welcome / loading / error

export function loadingScreen(msg = 'Casing the joint…'): HTMLElement {
  return h('div', { class: 'screen' }, h('div', { class: 'center' }, h('div', null, h('div', { class: 'spinner' }), h('div', { class: 'muted', style: { fontWeight: '800' } }, msg))));
}

export function errorScreen(title: string, msg: string, detail: string, onRetry: () => void): HTMLElement {
  return h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'center' },
      h(
        'div',
        { class: 'error-box' },
        h('div', { style: { color: 'var(--ruby)', width: '48px', height: '48px', margin: '0 auto' } }, svg('warning', 'ico--big')),
        h('h2', { class: 'display' }, title),
        h('p', null, msg, detail ? h('code', null, detail) : null),
        h('button', { class: 'btn', onClick: onRetry }, 'Try again'),
      ),
    ),
  );
}

export function welcomeScreen(o: { defaultName: string; busy: boolean; onStart: (name: string) => void }): HTMLElement {
  const input = h('input', { class: 'name-input', type: 'text', maxlength: '20', placeholder: 'Your codename', value: o.defaultName, autocomplete: 'off' }) as HTMLInputElement;
  const btn = h('button', { class: 'btn btn--lg', disabled: o.busy, onClick: () => o.onStart(input.value.trim()) }, o.busy ? 'Contacting the crew…' : 'Join the crew') as HTMLButtonElement;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });
  return h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'center' },
      h(
        'div',
        { style: { width: '100%', maxWidth: '320px' } },
        h(
          'div',
          { class: 'logo' },
          h('div', { class: 'logo__mark', html: logoSVG() }),
          h('div', { class: 'display logo__t gold-text' }, 'VAULT RUSH'),
          h('div', { class: 'logo__s' }, 'Live Heist Puzzle'),
        ),
        h('div', { style: { marginTop: '34px' } }, input),
        h('div', { style: { marginTop: '12px' } }, btn),
        h('p', { class: 'muted', style: { textAlign: 'center', fontSize: '12px', fontWeight: '800', marginTop: '14px' } }, 'One global heist a day. Same vault for everyone. Your nerve decides the score.'),
      ),
    ),
  );
}

function logoSVG(): string {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#c9962b"/></linearGradient></defs>
<circle cx="32" cy="32" r="26" fill="#141a33" stroke="url(#lg)" stroke-width="3"/>
<circle cx="32" cy="32" r="17" fill="none" stroke="url(#lg)" stroke-width="5"/>
<circle cx="32" cy="32" r="8" fill="url(#lg)"/>
<rect x="30" y="9" width="4" height="8" rx="2" fill="url(#lg)"/><rect x="30" y="47" width="4" height="8" rx="2" fill="url(#lg)"/>
<rect x="9" y="30" width="8" height="4" rx="2" fill="url(#lg)"/><rect x="47" y="30" width="8" height="4" rx="2" fill="url(#lg)"/></svg>`;
}

// ---------------------------------------------------------------- home

export interface HomeProps {
  profile: Profile;
  current: CurrentEvent | null;
  boosters: Set<string>;
  muted: boolean;
  starting: boolean;
  resumable: { vault: number; loot: number } | null;
  onToggleBooster: (id: string) => void;
  onStart: () => void;
  onLeaderboard: () => void;
  onShop: () => void;
  onToggleSound: () => void;
  onResume: () => void;
  onDiscard: () => void;
}

function hearts(p: Profile): HTMLElement {
  const wrap = h('span', { class: 'lives' });
  for (let i = 0; i < p.maxLives; i++) wrap.appendChild(svg(i < p.lives ? 'heart' : 'heartEmpty', i < p.lives ? '' : 'off'));
  return wrap;
}

export function homeScreen(p: HomeProps): HTMLElement {
  const { profile, current } = p;
  const theme = themeOf(current?.event.theme ?? 'louvre');
  const livesPill = h('span', { class: 'pill' }, hearts(profile), h('span', { class: 'num', id: 'life-timer' }));
  const screen = h('div', { class: 'screen screen--scroll' });

  const header = h(
    'div',
    { class: 'header' },
    h('div', { class: 'avatar' }, initials(profile.displayName)),
    h('div', null, h('div', { class: 'header__name' }, profile.displayName), h('div', { class: 'header__sub' }, `Best ${fmt(profile.stats.bestScore)} · ${profile.stats.runs} heists`)),
    h('div', { class: 'header__spacer' }),
    h('button', { class: 'icon-btn', onClick: p.onToggleSound, 'aria-label': 'sound' }, svg(p.muted ? 'muted' : 'sound')),
  );

  const stats = h('div', { class: 'stat-pills' }, h('span', { class: 'pill pill--gold' }, svg('coin'), h('span', { class: 'num' }, fmt(profile.coins))), livesPill);

  const timer = h('span', { class: 'num' });
  const hero = h(
    'div',
    { class: 'hero' },
    h(
      'div',
      { class: 'hero__art', html: heroArt(theme) },
    ),
    h(
      'div',
      { class: 'hero__body' },
      h('div', { class: 'eyebrow' }, `Today's global heist · ${theme.city}`),
      h('div', { class: 'display hero__title' }, current?.event.name ?? 'Loading heist…'),
      h('div', { class: 'hero__desc' }, 'Crack five vaults in a row. Escape any time to bank your loot, or go deeper for a bigger multiplier. Everyone plays the same vault today.'),
      current
        ? h(
            'div',
            { class: 'mults' },
            ...current.config.vaultMultipliers.map((m, i) => h('div', { class: 'mult' }, h('div', { class: 'mult__v' }, multStr(m)), h('div', { class: 'mult__l' }, `VAULT ${i + 1}`))),
          )
        : null,
      h(
        'div',
        { class: 'podium' },
        current && current.leaderboardPreview.length
          ? current.leaderboardPreview.map((e) =>
              h('div', { class: 'podium__row' }, h('span', { class: 'podium__rank' }, e.rank), h('span', { class: 'podium__name' }, e.name || 'Anonymous'), h('span', { class: 'podium__score num' }, fmt(e.score))),
            )
          : h('div', { class: 'podium__empty' }, 'No scores yet — be the first on the board.'),
        current?.me ? h('div', { class: 'podium__row', style: { marginTop: '4px', color: 'var(--gold-2)' } }, h('span', { class: 'podium__rank', style: { background: 'var(--glass-2)', color: '#fff' } }, '#'), h('span', { class: 'podium__name' }, `You are ${ordinal(current.me.rank)}`), h('span', { class: 'podium__score num' }, fmt(current.me.score))) : null,
      ),
    ),
  );
  const artEl = hero.querySelector('.hero__art') as HTMLElement;
  artEl.appendChild(h('div', { class: 'hero__badge' }, h('span', { class: 'dot' }), 'Live'));
  artEl.appendChild(h('div', { class: 'hero__timer' }, svg('clock'), timer));

  const boosterBtn = (id: string, cls: string, icon: 'bolt' | 'shield', title: string, sub: string) => {
    const n = profile.boosters[id] ?? 0;
    return h(
      'button',
      { class: `booster ${cls} ${p.boosters.has(id) ? 'on' : ''}`, disabled: n === 0, onClick: () => p.onToggleBooster(id) },
      h('span', { class: 'booster__ico' }, svg(icon)),
      h('span', null, h('div', { class: 'booster__t' }, title), h('div', { class: 'booster__s' }, sub)),
      h('span', { class: 'booster__n' }, `×${n}`),
    );
  };
  const boosters = h('div', { class: 'boosters' }, boosterBtn('extra_moves', 'booster--moves', 'bolt', 'Extra Moves', '+3 moves per vault'), boosterBtn('shield', 'booster--shield', 'shield', 'Shield', 'Half bust penalty'));

  const cost = current?.config.livesCost ?? 1;
  const canStart = !!current && current.event.status === 'ACTIVE' && profile.lives >= cost && !p.starting && !p.resumable;
  const cta = h(
    'div',
    { class: 'cta' },
    h(
      'button',
      { class: 'btn btn--lg', disabled: !canStart, onClick: p.onStart },
      p.starting ? 'Breaking in…' : profile.lives < cost ? 'Out of lives' : 'START HEIST',
      !p.starting && profile.lives >= cost ? h('span', { class: 'cta__cost' }, svg('heart'), `−${cost}`) : null,
    ),
  );

  const resume = p.resumable
    ? h(
        'div',
        { class: 'card resume' },
        svg('vault', 'ico--big'),
        h('div', null, h('div', { class: 'resume__t' }, `Heist in progress · Vault ${p.resumable.vault}`), h('div', { class: 'resume__s' }, `${fmt(p.resumable.loot)} loot on the table`)),
        h('button', { class: 'btn', onClick: p.onResume }, 'Resume'),
        h('button', { class: 'icon-btn', onClick: p.onDiscard, 'aria-label': 'abandon' }, svg('close')),
      )
    : null;

  const nav = h(
    'div',
    { class: 'nav' },
    h('button', { class: 'nav__item active' }, svg('home'), 'HOME'),
    h('button', { class: 'nav__item', onClick: p.onLeaderboard }, svg('trophy'), 'RANKS'),
    h('button', { class: 'nav__item', onClick: p.onShop }, svg('shop'), 'SHOP'),
  );

  screen.append(header, stats, hero, resume ?? '', boosters, cta, nav);

  tick(screen, () => {
    if (current) timer.textContent = current.event.status === 'ACTIVE' ? countdown(new Date(current.event.endsAt)) : current.event.status;
    const lt = screen.querySelector('#life-timer');
    if (lt) lt.textContent = profile.nextLifeAt && profile.lives < profile.maxLives ? ` ${shortCountdown(new Date(profile.nextLifeAt))}` : '';
  });
  return screen;
}

// ---------------------------------------------------------------- play

export interface PlayHud {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  setVault(index: number, total: number, mult: number, name: string): void;
  setMoves(n: number, pulse?: boolean): void;
  setObjectives(cur: Objectives, target: Objectives): void;
  setLoot(n: number): void;
  setPreview(text: string | null, color: string): void;
  setHint(text: string): void;
  setLadder(current: number, mults: number[]): void;
}

export function playScreen(o: { eventName: string; muted: boolean; onQuit: () => void; onToggleSound: () => boolean }): PlayHud {
  const vaultEl = h('div', { class: 'play__vault' });
  const movesN = h('div', { class: 'moves__n num' }, '0');
  const moves = h('div', { class: 'moves' }, movesN, h('div', { class: 'moves__l' }, 'MOVES'));
  const objectives = h('div', { class: 'objectives' });
  const lootN = h('div', { class: 'loot__n num' }, '0');
  const preview = h('div', { class: 'loot__preview num' });
  const canvas = h('canvas', { class: 'board' }) as HTMLCanvasElement;
  const hint = h('div', { class: 'play__hint' });
  const ladder = h('div', { class: 'ladder' });
  const soundBtn = h('button', { class: 'icon-btn', 'aria-label': 'sound' }, svg(o.muted ? 'muted' : 'sound'));
  soundBtn.addEventListener('click', () => {
    const muted = o.onToggleSound();
    soundBtn.replaceChildren(svg(muted ? 'muted' : 'sound'));
  });

  const root = h(
    'div',
    { class: 'screen play' },
    h(
      'div',
      { class: 'play__top' },
      h('button', { class: 'icon-btn', onClick: o.onQuit, 'aria-label': 'quit' }, svg('back')),
      h('div', { class: 'play__event' }, h('div', { class: 'play__event-name' }, o.eventName), vaultEl),
      soundBtn,
    ),
    h('div', { class: 'hud' }, moves, h('div', { class: 'hud__right' }, objectives, h('div', { class: 'loot' }, h('div', null, h('div', { class: 'loot__l' }, 'LOOT'), lootN), preview))),
    h('div', { class: 'board-wrap' }, canvas),
    hint,
    ladder,
    h(
      'div',
      { class: 'play__bottom' },
      h(
        'div',
        { class: 'legend' },
        legendItem(3, 'Cash'),
        legendItem(4, 'Diamond ×2.5'),
        legendItem(5, 'Guard +1 move'),
        legendItem(6, 'Lock'),
      ),
    ),
  );

  let lastMoves = -1;
  let lastObj: Objectives | null = null;
  let lastLoot = 0;

  return {
    root,
    canvas,
    setVault(index, total, mult, name) {
      vaultEl.replaceChildren(h('span', null, `Vault ${index}`), h('span', { class: 'muted', style: { fontSize: '14px', fontWeight: '800', fontFamily: 'var(--font-body)' } }, `of ${total} · ${name}`), h('span', { class: 'play__mult' }, multStr(mult)));
    },
    setMoves(n, pulse = false) {
      movesN.textContent = String(n);
      moves.classList.toggle('low', n <= 3);
      if (pulse || (lastMoves >= 0 && n !== lastMoves)) {
        moves.classList.remove('bump');
        void moves.offsetWidth;
        moves.classList.add('bump');
      }
      lastMoves = n;
    },
    setObjectives(cur, target) {
      const rows: Array<[keyof Objectives, number]> = [
        ['key', 0],
        ['laser', 1],
        ['camera', 2],
      ];
      objectives.replaceChildren(
        ...rows
          .filter(([k]) => target[k] > 0)
          .map(([k, t]) => {
            const style = TILE_STYLE[t];
            const done = cur[k] === 0;
            const changed = lastObj && lastObj[k] !== cur[k];
            const el = h(
              'div',
              { class: `obj ${done ? 'done' : ''} ${changed ? 'bump' : ''}` },
              h('span', { class: 'obj__ico', style: { background: `linear-gradient(180deg, ${style.top}, ${style.bottom})` }, html: tileIconSVG(t) }),
              h('span', null, h('div', { class: 'obj__n num' }, done ? '✓' : cur[k]), h('div', { class: 'obj__l' }, style.label)),
              done ? h('span', { class: 'obj__check' }, svg('check')) : null,
            );
            return el;
          }),
      );
      lastObj = { ...cur };
    },
    setLoot(n) {
      if (n !== lastLoot) void animateNumber(lootN, lastLoot, n, 500);
      lastLoot = n;
    },
    setPreview(text, color) {
      if (text) {
        preview.textContent = text;
        preview.style.color = color;
        preview.classList.add('show');
      } else preview.classList.remove('show');
    },
    setHint(text) {
      hint.innerHTML = text;
    },
    setLadder(current, mults) {
      ladder.replaceChildren(
        ...mults.map((m, i) =>
          h('div', { class: `step ${i < current ? 'done' : i === current ? 'current' : ''}` }, h('div', { class: 'step__v' }, i < current ? '✓' : multStr(m)), h('div', { class: 'step__l' }, `VAULT ${i + 1}`)),
        ),
      );
    },
  };
}

function legendItem(t: number, label: string): HTMLElement {
  return h('span', { class: 'legend__i' }, h('span', { class: 'legend__sw', style: { background: `linear-gradient(180deg, ${TILE_STYLE[t].top}, ${TILE_STYLE[t].bottom})` } }), label);
}

// ---------------------------------------------------------------- banner / decision

export function banner(kind: 'cracked' | 'busted', title: string, sub: string, ms = 1500): Promise<void> {
  const overlay = document.getElementById('overlay')!;
  const flash = h('div', { class: 'flash', style: { background: kind === 'cracked' ? 'radial-gradient(circle, rgba(247,201,72,.9), rgba(247,201,72,0) 70%)' : 'radial-gradient(circle, rgba(255,77,109,.9), rgba(255,77,109,0) 70%)' } });
  const el = h('div', { class: `banner banner--${kind}` }, h('div', { class: 'banner__box' }, h('div', { class: `display banner__t ${kind === 'cracked' ? 'gold-text' : ''}` }, title), h('div', { class: 'banner__s' }, sub)));
  overlay.append(flash, el);
  return new Promise((resolve) =>
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'scale(1.05)';
      setTimeout(() => {
        el.remove();
        flash.remove();
        resolve();
      }, 250);
    }, ms),
  );
}

export interface DecisionProps {
  vault: number;
  total: number;
  loot: number;
  currentMult: number;
  nextMult: number;
  escapeScore: number;
  deeperScore: number;
  bustScore: number;
  nextVault: Vault;
  nextObjectives: Objectives;
  onEscape: () => void;
  onDeeper: () => void;
}

export function decisionModal(p: DecisionProps): HTMLElement {
  const objs: string[] = [];
  if (p.nextObjectives.key) objs.push(`${p.nextObjectives.key} keys`);
  if (p.nextObjectives.laser) objs.push(`${p.nextObjectives.laser} lasers`);
  if (p.nextObjectives.camera) objs.push(`${p.nextObjectives.camera} cameras`);
  const el = h(
    'div',
    { class: 'modal' },
    h(
      'div',
      { class: 'modal__sheet' },
      h('div', { class: 'eyebrow', style: { textAlign: 'center' } }, `Vault ${p.vault} of ${p.total} cracked`),
      h('div', { class: 'display modal__title gold-text', style: { marginTop: '6px' } }, `${fmt(p.loot)} LOOT`),
      h('div', { class: 'modal__sub' }, 'Bank it now, or push your luck?'),
      h(
        'div',
        { class: 'decision' },
        h(
          'button',
          { class: 'choice choice--escape', onClick: p.onEscape },
          h('span', { class: 'choice__ico' }, multStr(p.currentMult)),
          h('span', null, h('div', { class: 'choice__t' }, 'ESCAPE'), h('div', { class: 'choice__d' }, 'Secure everything you have collected so far.')),
          h('span', { class: 'choice__v num' }, fmt(p.escapeScore), h('small', null, 'GUARANTEED')),
        ),
        h(
          'button',
          { class: 'choice choice--deeper', onClick: p.onDeeper },
          h('span', { class: 'choice__ico' }, multStr(p.nextMult)),
          h('span', null, h('div', { class: 'choice__t' }, 'GO DEEPER'), h('div', { class: 'choice__d' }, `${p.nextVault.name}: ${objs.join(', ')} in ${p.nextVault.moves} moves${p.nextVault.locks ? `, ${p.nextVault.locks} locks` : ''}.`)),
          h('span', { class: 'choice__v num' }, fmt(p.deeperScore), h('small', null, 'IF YOU CRACK IT')),
        ),
      ),
      h('div', { class: 'risk' }, h('span', null, 'Bust in the next vault and you walk away with ', h('b', { class: 'num' }, fmt(p.bustScore)))),
    ),
  );
  return el;
}

export function confirmModal(title: string, msg: string, confirmLabel: string, onConfirm: () => void, onCancel: () => void): HTMLElement {
  return h(
    'div',
    { class: 'modal', onClick: (e: Event) => e.target === e.currentTarget && onCancel() },
    h(
      'div',
      { class: 'modal__sheet' },
      h('div', { class: 'display modal__title' }, title),
      h('div', { class: 'modal__sub' }, msg),
      h('div', { class: 'decision' }, h('button', { class: 'btn btn--danger', onClick: onConfirm }, confirmLabel), h('button', { class: 'btn btn--ghost', onClick: onCancel }, 'Keep playing')),
    ),
  );
}

// ---------------------------------------------------------------- result

export interface ResultProps {
  eventName: string;
  outcome: 'ESCAPED' | 'BUSTED';
  score: number;
  loot: number;
  multiplier: number;
  vaultReached: number;
  vaultsCracked: number;
  totalVaults: number;
  penalty: number; // 0..1 applied when busted
  shield: boolean;
  reward: Reward | null;
  claimed: boolean;
  claiming: boolean;
  rank: LBEntry | null;
  total: number;
  submitting: boolean;
  error: string | null;
  canPlayAgain: boolean;
  onClaim: () => void;
  onHome: () => void;
  onLeaderboard: () => void;
  onPlayAgain: () => void;
  onRetry: () => void;
}

export function resultScreen(p: ResultProps): HTMLElement {
  const escaped = p.outcome === 'ESCAPED';
  const scoreEl = h('div', { class: `display result__score num ${escaped ? 'gold-text' : ''}`, style: escaped ? {} : { color: '#ffb3c1' } }, '0');
  const rows: Array<[string, string, boolean]> = [
    ['Loot collected', fmt(p.loot), false],
    [`Vault ${p.vaultReached} multiplier`, multStr(p.multiplier), false],
  ];
  if (!escaped) rows.push([`Busted penalty${p.shield ? ' (shield)' : ''}`, `−${Math.round(p.penalty * 100)}%`, false]);
  rows.push(['Final score', fmt(p.score), true]);

  const rewardCard = p.reward
    ? h(
        'div',
        { class: `card reward ${p.claimed ? 'claimed' : ''}` },
        h('span', { class: 'reward__ico' }, svg('coin')),
        h('div', null, h('div', { class: 'reward__t' }, `+${fmt(p.reward.coins)} coins`), h('div', { class: 'reward__s' }, p.claimed ? 'Added to your stash' : 'Heist payout · claim exactly once')),
        h('button', { class: 'btn', disabled: p.claimed || p.claiming, onClick: p.onClaim }, p.claimed ? [svg('check'), 'Claimed'] : p.claiming ? 'Claiming…' : 'Claim'),
      )
    : null;

  const screen = h(
    'div',
    { class: 'screen screen--scroll result' },
    h('div', { class: 'eyebrow', style: { marginTop: '6px' } }, p.eventName),
    h(
      'div',
      { class: `result__badge ${escaped ? 'pill pill--emerald' : 'pill pill--ruby'}` },
      svg(escaped ? 'sparkle' : 'warning'),
      escaped ? (p.vaultsCracked === p.totalVaults ? 'CLEAN SWEEP' : 'ESCAPED') : 'BUSTED',
    ),
    p.submitting
      ? h('div', { style: { marginTop: '18px' } }, h('div', { class: 'spinner' }), h('div', { class: 'muted', style: { fontWeight: '800' } }, 'Server is replaying your heist…'))
      : p.error
        ? h('div', { style: { marginTop: '18px' } }, h('div', { class: 'display', style: { fontSize: '22px', color: '#ffb3c1' } }, 'Could not submit'), h('p', { class: 'muted', style: { fontWeight: '800' } }, p.error), h('button', { class: 'btn', onClick: p.onRetry }, 'Retry submission'))
        : [
            scoreEl,
            h('div', { class: 'result__score-l' }, `${p.vaultsCracked} of ${p.totalVaults} vaults cracked`),
            p.rank ? h('div', { class: 'pill pill--gold result__rank' }, svg('trophy'), `Ranked ${ordinal(p.rank.rank)}${p.total ? ` of ${fmt(p.total)}` : ''}`) : null,
            h(
              'div',
              { class: 'card breakdown' },
              ...rows.map(([l, v, total]) => h('div', { class: `breakdown__row ${total ? 'total' : ''}` }, h('span', null, l), h('b', { class: 'num' }, v))),
            ),
            rewardCard,
          ],
    h(
      'div',
      { class: 'result__actions' },
      h('button', { class: 'btn btn--lg', disabled: !p.canPlayAgain || p.submitting, onClick: p.onPlayAgain }, p.canPlayAgain ? 'PLAY AGAIN' : 'OUT OF LIVES'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn--ghost', onClick: p.onLeaderboard }, svg('trophy'), 'Leaderboard'), h('button', { class: 'btn btn--ghost', onClick: p.onHome }, svg('home'), 'Home')),
    ),
  );
  if (!p.submitting && !p.error) requestAnimationFrame(() => void animateNumber(scoreEl, 0, p.score, 1100));
  return screen;
}

// ---------------------------------------------------------------- leaderboard

export interface LBProps {
  eventName: string;
  endsAt: string | null;
  tab: 'global' | 'rivals';
  board: Board | null;
  myId: string;
  loading: boolean;
  onBack: () => void;
  onTab: (t: 'global' | 'rivals') => void;
}

const AV_COLORS = ['#5aa9ff', '#a26bff', '#3dd68c', '#ff6b82', '#f7c948', '#8ee8ff', '#ff9f43'];
function avColor(id: string): string {
  let hsh = 0;
  for (const ch of id) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[hsh % AV_COLORS.length];
}

function lbRow(e: LBEntry, me: boolean): HTMLElement {
  return h(
    'div',
    { class: `lb__row ${me ? 'me' : ''}` },
    h('span', { class: `lb__rank r${e.rank}` }, e.rank),
    h('span', { class: 'lb__av', style: { background: avColor(e.playerId) } }, initials(e.name || 'A')),
    h('span', { class: 'lb__name' }, e.name || 'Anonymous', me ? h('small', null, 'You') : null),
    h('span', { class: 'lb__score num' }, fmt(e.score)),
  );
}

export function leaderboardScreen(p: LBProps): HTMLElement {
  const timer = h('span', { class: 'num' });
  const list = h('div', { class: 'lb' });
  if (p.loading) {
    for (let i = 0; i < 8; i++) list.appendChild(h('div', { class: 'skeleton', style: { height: '54px' } }));
  } else if (!p.board || p.board.entries.length === 0) {
    list.appendChild(h('div', { class: 'empty' }, svg('trophy'), h('div', null, p.tab === 'rivals' ? 'Finish a heist to see who is around you.' : 'Nobody has scored yet. Crack the first vault.')));
  } else {
    p.board.entries.forEach((e, i) => {
      const row = lbRow(e, e.playerId === p.myId);
      row.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
      list.appendChild(row);
    });
  }
  const inList = !!p.board?.entries.some((e) => e.playerId === p.myId);
  const sticky = p.board?.me && !inList ? h('div', { class: 'lb__sticky' }, lbRow({ ...p.board.me, name: 'You' }, true)) : null;

  const screen = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'topbar' }, h('button', { class: 'icon-btn', onClick: p.onBack }, svg('back')), h('div', { class: 'display topbar__title' }, 'Global Heist'), h('span', { style: { width: '42px' } })),
    h(
      'div',
      { class: 'tabs' },
      h('button', { class: `tab ${p.tab === 'global' ? 'active' : ''}`, onClick: () => p.onTab('global') }, svg('globe'), 'Top 100'),
      h('button', { class: `tab ${p.tab === 'rivals' ? 'active' : ''}`, onClick: () => p.onTab('rivals') }, svg('users'), 'Rivals'),
    ),
    h('div', { class: 'lb-meta' }, h('span', null, p.eventName), h('span', null, p.board ? `${fmt(p.board.total)} players · ` : '', timer)),
    list,
    sticky,
  );
  tick(screen, () => {
    timer.textContent = p.endsAt ? `ends in ${countdown(new Date(p.endsAt))}` : '';
  });
  return screen;
}

// ---------------------------------------------------------------- shop

export interface ShopProps {
  items: ShopItem[];
  profile: Profile;
  buying: string | null;
  onBuy: (id: string) => void;
  onBack: () => void;
}

export function shopScreen(p: ShopProps): HTMLElement {
  const iconFor = (id: string) => (id === 'shield' ? svg('shield') : id === 'life' ? svg('heart') : svg('bolt'));
  const colorFor = (id: string) => (id === 'shield' ? 'rgba(90,169,255,.2)' : id === 'life' ? 'rgba(255,77,109,.2)' : 'rgba(162,107,255,.2)');
  const fg = (id: string) => (id === 'shield' ? '#bcdcff' : id === 'life' ? '#ffb3c1' : '#d5c2ff');
  return h(
    'div',
    { class: 'screen screen--scroll' },
    h('div', { class: 'topbar' }, h('button', { class: 'icon-btn', onClick: p.onBack }, svg('back')), h('div', { class: 'display topbar__title' }, 'Black Market'), h('span', { style: { width: '42px' } })),
    h('div', { class: 'stat-pills' }, h('span', { class: 'pill pill--gold', style: { flex: 'none', margin: '0 auto' } }, svg('coin'), h('span', { class: 'num' }, fmt(p.profile.coins)))),
    h(
      'div',
      { class: 'shop' },
      ...p.items.map((it) => {
        const owned = it.kind === 'booster' ? (p.profile.boosters[it.itemId] ?? 0) : null;
        const cantAfford = p.profile.coins < it.price;
        const livesFull = it.kind === 'life' && p.profile.lives >= p.profile.maxLives;
        return h(
          'div',
          { class: 'card item' },
          h('span', { class: 'item__ico', style: { background: colorFor(it.itemId), color: fg(it.itemId) } }, iconFor(it.itemId)),
          h('div', null, h('div', { class: 'item__t' }, it.name), h('div', { class: 'item__d' }, it.description), owned !== null ? h('div', { class: 'item__owned' }, `Owned ×${owned}`) : livesFull ? h('div', { class: 'item__owned', style: { color: 'var(--emerald)' } }, 'Lives full') : null),
          h('button', { class: 'btn', disabled: cantAfford || livesFull || p.buying !== null, onClick: () => p.onBuy(it.itemId) }, p.buying === it.itemId ? '…' : [svg('coin'), h('span', { class: 'num' }, fmt(it.price))]),
        );
      }),
    ),
    h('p', { class: 'muted', style: { textAlign: 'center', fontSize: '12px', fontWeight: '800', marginTop: '16px' } }, 'Purchases are version-checked on the server: two taps can never spend the same coin twice.'),
  );
}

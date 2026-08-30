/**
 * Tile art. Every icon is hand-drawn SVG rendered once into an Image and
 * cached, so the canvas can draw crisp sprites at any DPR without assets.
 */
export interface TileStyle {
  top: string;
  bottom: string;
  glow: string;
  edge: string;
  label: string;
}

export const TILE_STYLE: TileStyle[] = [
  { top: '#FFD36B', bottom: '#E08A12', glow: '#FFC94D', edge: '#8A4F05', label: 'Key' },
  { top: '#FF6B82', bottom: '#C40F36', glow: '#FF4D6D', edge: '#6E0A1F', label: 'Laser' },
  { top: '#7FC1FF', bottom: '#2062C9', glow: '#5AA9FF', edge: '#12386F', label: 'Camera' },
  { top: '#6FE7A8', bottom: '#15915A', glow: '#3DD68C', edge: '#0B4A2E', label: 'Cash' },
  { top: '#B9F3FF', bottom: '#4E62E6', glow: '#8EE8FF', edge: '#25317F', label: 'Diamond' },
  { top: '#C39BFF', bottom: '#6B34C8', glow: '#A26BFF', edge: '#381A6B', label: 'Guard' },
  { top: '#6E7686', bottom: '#2C313D', glow: '#8B95A7', edge: '#171A22', label: 'Lock' },
];

/** Icon-only SVG (no tile background) for a given tile id. */
export function tileIconSVG(t: number): string {
  switch (t) {
    case 0: // key
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF6D6"/><stop offset="1" stop-color="#F3B62B"/></linearGradient></defs>
<g transform="rotate(-40 32 32)">
<circle cx="22" cy="32" r="12" fill="none" stroke="url(#k)" stroke-width="7"/>
<circle cx="22" cy="32" r="3.5" fill="#B8791A"/>
<rect x="31" y="28.5" width="26" height="7" rx="3.5" fill="url(#k)"/>
<rect x="46" y="34" width="5" height="9" rx="2" fill="url(#k)"/>
<rect x="53" y="34" width="4" height="7" rx="2" fill="url(#k)"/>
</g>
<ellipse cx="24" cy="22" rx="6" ry="3" fill="#fff" opacity=".35" transform="rotate(-40 24 22)"/>
</svg>`;
    case 1: // laser emitter
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="l" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".35" stop-color="#FFB3C1"/><stop offset="1" stop-color="#FF2D55" stop-opacity="0"/></radialGradient></defs>
<g stroke="#FFD9E0" stroke-width="3" stroke-linecap="round" opacity=".95">
<line x1="32" y1="6" x2="32" y2="20"/><line x1="32" y1="44" x2="32" y2="58"/><line x1="6" y1="32" x2="20" y2="32"/><line x1="44" y1="32" x2="58" y2="32"/>
</g>
<g stroke="#FFD9E0" stroke-width="2" stroke-linecap="round" opacity=".6">
<line x1="14" y1="14" x2="22" y2="22"/><line x1="50" y1="50" x2="42" y2="42"/><line x1="50" y1="14" x2="42" y2="22"/><line x1="14" y1="50" x2="22" y2="42"/>
</g>
<circle cx="32" cy="32" r="16" fill="url(#l)"/>
<circle cx="32" cy="32" r="8" fill="#FFF5F7"/>
<circle cx="32" cy="32" r="4" fill="#FF2D55"/>
</svg>`;
    case 2: // security camera
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4F8FF"/><stop offset="1" stop-color="#B9D2F5"/></linearGradient></defs>
<rect x="28" y="10" width="8" height="10" rx="2" fill="#DCE8FA"/>
<rect x="14" y="8" width="36" height="5" rx="2.5" fill="#DCE8FA"/>
<g transform="rotate(-14 30 34)">
<rect x="10" y="24" width="38" height="20" rx="6" fill="url(#c)"/>
<rect x="44" y="27" width="12" height="14" rx="4" fill="#DCE8FA"/>
<circle cx="52" cy="34" r="4.5" fill="#1B2A44"/>
<circle cx="52" cy="34" r="2" fill="#5AA9FF"/>
<circle cx="18" cy="30" r="2.2" fill="#FF3B5C"/>
</g>
</svg>`;
    case 3: // cash stack
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F1FFF5"/><stop offset="1" stop-color="#BFF2D2"/></linearGradient></defs>
<g transform="rotate(-8 32 34)">
<rect x="10" y="30" width="44" height="14" rx="3" fill="#8FE0B0"/>
<rect x="10" y="24" width="44" height="14" rx="3" fill="#B6EFCB"/>
<rect x="10" y="18" width="44" height="16" rx="3" fill="url(#m)"/>
<rect x="24" y="14" width="16" height="24" rx="2" fill="#E7C775" opacity=".9"/>
<circle cx="32" cy="26" r="5.5" fill="none" stroke="#1E9A5C" stroke-width="2"/>
<text x="32" y="29.5" font-family="Fredoka, Nunito, sans-serif" font-weight="700" font-size="9" text-anchor="middle" fill="#1E9A5C">$</text>
</g>
</svg>`;
    case 4: // brilliant-cut diamond
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="d1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#9FDDFF"/></linearGradient>
<linearGradient id="d2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C6F0FF"/><stop offset="1" stop-color="#5B8CFF"/></linearGradient></defs>
<polygon points="14,24 22,12 42,12 50,24" fill="url(#d1)"/>
<polygon points="14,24 50,24 32,52" fill="url(#d2)"/>
<polygon points="22,12 32,24 42,12" fill="#EAFBFF"/>
<polygon points="14,24 22,12 32,24" fill="#B8E9FF"/>
<polygon points="42,12 50,24 32,24" fill="#B8E9FF"/>
<polygon points="14,24 32,24 32,52" fill="#7FB4FF" opacity=".75"/>
<polygon points="32,24 50,24 32,52" fill="#5E85F0" opacity=".55"/>
<circle cx="24" cy="18" r="2.2" fill="#fff"/>
<circle cx="40" cy="30" r="1.5" fill="#fff" opacity=".8"/>
</svg>`;
    case 5: // guard cap + badge
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4ECFF"/><stop offset="1" stop-color="#C9B0F5"/></linearGradient></defs>
<path d="M12 30 Q32 8 52 30 L52 36 L12 36 Z" fill="url(#g1)"/>
<rect x="8" y="34" width="48" height="8" rx="4" fill="#3B2670"/>
<path d="M10 42 Q32 50 54 42 L52 46 Q32 54 12 46 Z" fill="#2B1B52"/>
<polygon points="32,18 34.5,24 41,24 36,28 38,34 32,30.5 26,34 28,28 23,24 29.5,24" fill="#FFD36B"/>
</svg>`;
    case 6: // padlock
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D9DEE8"/><stop offset="1" stop-color="#8E97A8"/></linearGradient></defs>
<path d="M20 30 V22 a12 12 0 0 1 24 0 V30" fill="none" stroke="#C9D0DC" stroke-width="6" stroke-linecap="round"/>
<rect x="14" y="28" width="36" height="28" rx="7" fill="url(#p)"/>
<circle cx="32" cy="40" r="4.5" fill="#2A2F3B"/>
<rect x="30" y="42" width="4" height="8" rx="2" fill="#2A2F3B"/>
</svg>`;
    default:
      return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
}

const cache = new Map<number, HTMLImageElement>();
const loading = new Map<number, Promise<HTMLImageElement>>();

export function tileImage(t: number): HTMLImageElement | null {
  return cache.get(t) ?? null;
}

function load(t: number): Promise<HTMLImageElement> {
  const existing = loading.get(t);
  if (existing) return existing;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    const svg = tileIconSVG(t);
    img.onload = () => {
      cache.set(t, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  loading.set(t, p);
  return p;
}

export async function preloadTiles(): Promise<void> {
  await Promise.all([0, 1, 2, 3, 4, 5, 6].map(load));
}

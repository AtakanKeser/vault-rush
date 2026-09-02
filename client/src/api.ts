/**
 * Thin typed client for the Vault Rush API (docs/api.md).
 * Auth token + device id live in localStorage; every mutating call may carry
 * an Idempotency-Key so a retry after a dropped connection is safe.
 */
import type { Config, Replay } from './engine/engine';

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';

export interface Stats {
  runs: number;
  bestScore: number;
  totalLoot: number;
  vaultsCracked: number;
}
export interface Profile {
  playerId: string;
  displayName: string;
  coins: number;
  lives: number;
  maxLives: number;
  nextLifeAt: string | null;
  boosters: Record<string, number>;
  stats: Stats;
  experimentGroup: string;
  version: number;
  createdAt: string;
}
export interface EventInfo {
  eventId: string;
  name: string;
  theme: string;
  status: 'UPCOMING' | 'ACTIVE' | 'ENDED';
  startsAt: string;
  endsAt: string;
  configVersion: number;
}
export interface LBEntry {
  rank: number;
  playerId: string;
  name: string;
  score: number;
}
export interface CurrentEvent {
  event: EventInfo;
  config: Config;
  leaderboardPreview: LBEntry[];
  me: LBEntry | null;
  serverTime: string;
}
export interface StartResponse {
  runId: string;
  playerId: string;
  eventId: string;
  seed: number;
  configVersion: number;
  boosters: string[];
  startedAt: string;
  expiresAt: string;
  config: Config;
}
export interface Reward {
  rewardId: string;
  type: string;
  title: string;
  coins: number;
  boosters?: Record<string, number>;
  status: 'PENDING' | 'CLAIMED';
}
export interface FinishResponse {
  runId: string;
  outcome: 'ESCAPED' | 'BUSTED';
  score: number;
  loot: number;
  vaultReached: number;
  vaultsCracked: number;
  multiplier: number;
  reward: Reward | null;
  profile: Profile;
}
export interface Board {
  eventId: string;
  total: number;
  entries: LBEntry[];
  me: LBEntry | null;
}
export interface ShopItem {
  itemId: string;
  name: string;
  description: string;
  price: number;
  kind: 'booster' | 'life';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const LS = {
  device: 'vr_device',
  token: 'vr_token',
  name: 'vr_name',
} as const;

function ls(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode */
  }
}

export function deviceId(): string {
  let id = ls(LS.device);
  if (!id) {
    id = 'web-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    lsSet(LS.device, id);
  }
  return id;
}

export function savedName(): string | null {
  return ls(LS.name);
}

let token: string | null = ls(LS.token);

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(API_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the heist server');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  hasSession(): boolean {
    return !!token;
  },

  async ensurePlayer(displayName?: string): Promise<Profile> {
    const name = displayName ?? savedName() ?? '';
    const res = await request<{ playerId: string; token: string; profile: Profile }>('POST', '/v1/player', {
      deviceId: deviceId(),
      displayName: name,
    });
    token = res.token;
    lsSet(LS.token, token);
    lsSet(LS.name, res.profile.displayName);
    return res.profile;
  },

  profile: () => request<Profile>('GET', '/v1/player/profile'),
  currentEvent: () => request<CurrentEvent>('GET', '/v1/events/current'),
  startHeist: (boosters: string[], idemKey: string) =>
    request<StartResponse>('POST', '/v1/heists/start', { boosters }, { 'Idempotency-Key': idemKey }),
  finishHeist: (runId: string, replay: Replay, idemKey: string) =>
    request<FinishResponse>('POST', `/v1/heists/${encodeURIComponent(runId)}/finish`, replay, { 'Idempotency-Key': idemKey }),
  leaderboard: (eventId?: string, limit = 100) =>
    request<Board>('GET', `/v1/leaderboard/global?limit=${limit}${eventId ? `&eventId=${encodeURIComponent(eventId)}` : ''}`),
  rivals: (eventId?: string) => request<Board>('GET', `/v1/leaderboard/friends${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''}`),
  rewards: () => request<{ rewards: Reward[] }>('GET', '/v1/rewards'),
  claim: (rewardId: string, idemKey: string) =>
    request<{ rewardId: string; coins: number; status: string; profile: Profile }>('POST', '/v1/rewards/claim', { rewardId }, { 'Idempotency-Key': idemKey }),
  catalog: () => request<{ items: ShopItem[] }>('GET', '/v1/shop/catalog'),
  purchase: (itemId: string, idemKey: string) =>
    request<{ profile: Profile }>('POST', '/v1/shop/purchase', { itemId }, { 'Idempotency-Key': idemKey }),
};

export function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

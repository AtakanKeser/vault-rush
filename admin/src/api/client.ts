import type {
  EventAnalytics,
  EventConfig,
  EventDetailResponse,
  EventMeta,
  Experiment,
  GrantRequest,
  Healthz,
  Metrics,
  PlayerResponse,
  Profile,
  PutConfigResponse,
  Readyz,
  SystemInfo,
} from './types'

export const TOKEN_KEY = 'vr_admin_token'
export const DEFAULT_LOCAL_TOKEN = 'local-admin-token'
const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

export class ApiError extends Error {
  status: number
  code: string
  requestId: string | null
  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable — session only */
  }
}
export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

let unauthorizedHandler: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

interface RequestOptions {
  /** Statuses that should resolve with the parsed body instead of throwing (e.g. 503 from /readyz). */
  passthrough?: number[]
  /** Override the admin token (used to validate a token before storing it). */
  token?: string
  signal?: AbortSignal
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = opts.token ?? getToken()
  if (token) headers['X-Admin-Token'] = token
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API. Is the backend (or mock) running?')
  }

  const requestId = res.headers.get('X-Request-Id')
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (res.ok || opts.passthrough?.includes(res.status)) return data as T

  const err = (data as { error?: { code?: string; message?: string } } | null)?.error
  const code = err?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : `HTTP_${res.status}`)
  const message = err?.message ?? (data ? text.slice(0, 200) : res.statusText || 'Request failed')

  if ((res.status === 401 || res.status === 403) && path.startsWith('/admin/') && !opts.token) {
    clearToken()
    unauthorizedHandler?.()
  }
  throw new ApiError(res.status, code, message, requestId)
}

export const api = {
  // Admin
  events: (window = 7, signal?: AbortSignal) =>
    request<{ events: EventMeta[] }>('GET', `/admin/v1/events?window=${window}`, undefined, { signal }),
  event: (eventId: string, signal?: AbortSignal) =>
    request<EventDetailResponse>('GET', `/admin/v1/events/${encodeURIComponent(eventId)}`, undefined, { signal }),
  eventConfigVersion: (eventId: string, version: number, signal?: AbortSignal) =>
    request<{ config: EventConfig }>('GET', `/admin/v1/events/${encodeURIComponent(eventId)}/config/${version}`, undefined, { signal }),
  putEventConfig: (eventId: string, config: Partial<EventConfig>, note: string, createdBy: string) =>
    request<PutConfigResponse>('PUT', `/admin/v1/events/${encodeURIComponent(eventId)}/config`, { config, note, createdBy }),
  eventAnalytics: (eventId: string, signal?: AbortSignal) =>
    request<EventAnalytics>('GET', `/admin/v1/events/${encodeURIComponent(eventId)}/analytics`, undefined, { signal }),
  experiments: (signal?: AbortSignal) => request<{ experiments: Experiment[] }>('GET', '/admin/v1/experiments', undefined, { signal }),
  player: (playerId: string, signal?: AbortSignal) =>
    request<PlayerResponse>('GET', `/admin/v1/players/${encodeURIComponent(playerId)}`, undefined, { signal }),
  grant: (playerId: string, body: GrantRequest) =>
    request<{ profile: Profile }>('POST', `/admin/v1/players/${encodeURIComponent(playerId)}/grant`, body),
  system: (signal?: AbortSignal, token?: string) => request<SystemInfo>('GET', '/admin/v1/system', undefined, { signal, token }),

  // Ops (unauthenticated)
  healthz: (signal?: AbortSignal) => request<Healthz>('GET', '/healthz', undefined, { signal, passthrough: [503] }),
  readyz: (signal?: AbortSignal) => request<Readyz>('GET', '/readyz', undefined, { signal, passthrough: [503] }),
  metrics: (signal?: AbortSignal) => request<Metrics>('GET', '/metrics', undefined, { signal }),
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.code === 'NETWORK_ERROR' ? e.message : `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

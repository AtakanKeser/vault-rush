// Vault Rush — zero-dependency mock of the LiveOps admin API.
// Shapes follow docs/api.md exactly so the real Go backend can replace it 1:1.
//
//   node mock/server.mjs            # http://localhost:8080
//   PORT=9090 ADMIN_TOKEN=xyz node mock/server.mjs

import http from 'node:http'

const PORT = Number(process.env.PORT || 8080)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'local-admin-token'
const STARTED_AT = Date.now()

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32, same as the engine) so data is stable across
// restarts and screenshots.
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getUTCFullYear()}_${pad(d.getUTCMonth() + 1)}_${pad(d.getUTCDate())}`
const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

// ---------------------------------------------------------------------------
// Event catalogue
// ---------------------------------------------------------------------------
const THEMES = [
  { theme: 'louvre', name: 'Louvre Diamond Heist' },
  { theme: 'bank', name: 'Zurich Vault Job' },
  { theme: 'casino', name: 'Monaco Casino Night' },
  { theme: 'museum', name: 'Cairo Museum Raid' },
  { theme: 'yacht', name: 'Riviera Yacht Sting' },
  { theme: 'train', name: 'Orient Express Grab' },
  { theme: 'mansion', name: 'Hamptons Mansion Run' },
  { theme: 'embassy', name: 'Embassy Blackout' },
  { theme: 'vegas', name: 'Vegas Strip Score' },
]

const VAULT_TEMPLATES = [
  { name: 'Lobby Safe', moves: 18, objectives: { key: 8, laser: 0, camera: 0 }, locks: 0, weights: { key: 20, laser: 16, camera: 16, money: 20, diamond: 10, guard: 12 } },
  { name: 'Security Desk', moves: 20, objectives: { key: 6, laser: 6, camera: 0 }, locks: 2, weights: { key: 18, laser: 18, camera: 14, money: 20, diamond: 10, guard: 12 } },
  { name: 'Server Room', moves: 22, objectives: { key: 6, laser: 6, camera: 6 }, locks: 3, weights: { key: 16, laser: 16, camera: 16, money: 20, diamond: 12, guard: 12 } },
  { name: 'Gallery Vault', moves: 24, objectives: { key: 8, laser: 8, camera: 8 }, locks: 5, weights: { key: 16, laser: 16, camera: 16, money: 18, diamond: 14, guard: 12 } },
  { name: 'Diamond Room', moves: 26, objectives: { key: 10, laser: 10, camera: 10 }, locks: 7, weights: { key: 15, laser: 15, camera: 15, money: 18, diamond: 16, guard: 12 } },
]

function baseConfig(eventId, seed) {
  return {
    eventId,
    version: 1,
    seed,
    difficulty: 1.0,
    lootMultiplier: 1.0,
    livesCost: 1,
    grid: { w: 7, h: 7 },
    vaultMultipliers: [1, 1.5, 2, 3, 5],
    bustPenalty: 0.5,
    vaults: VAULT_TEMPLATES.map((v) => JSON.parse(JSON.stringify(v))),
  }
}

/** @type {Map<string, {meta: object, versions: object[]}>} */
const events = new Map()

function ensureEvent(dayOffset) {
  const today = startOfUtcDay(new Date())
  const start = new Date(today.getTime() + dayOffset * 86400000)
  const end = new Date(start.getTime() + 86400000)
  const t = THEMES[((dayOffset % THEMES.length) + THEMES.length * 3) % THEMES.length]
  const eventId = `${t.theme}_${dayKey(start)}`
  if (events.has(eventId)) return events.get(eventId)

  const r = rng(fnv1a(eventId))
  const seed = Math.floor(r() * 0xffffffff)
  const versions = []
  const cfg = baseConfig(eventId, seed)
  const createdBase = new Date(start.getTime() - 3 * 86400000)

  // Provision a realistic version history for today's + yesterday's events.
  const historyLen = dayOffset === 0 ? 17 : dayOffset === -1 ? 9 : 1
  const notes = [
    'Initial provisioning',
    'Tuned lobby weights for onboarding',
    'Raised loot multiplier for launch weekend',
    'Vault 3 lasers too dense, reduced to 6',
    'Added locks to Gallery Vault',
    'Difficulty +0.05 after completion spike',
    'Reverted seed after QA report',
    'Vault 4 too hard, lowered lasers',
    'Bust penalty 0.6 → 0.5 (retention test)',
    'Diamond weight +2 on final vault',
    'Moves +1 on Security Desk',
    'Fixed camera objective on vault 2',
    'Hotfix: grid seed refresh',
    'Loot 1.1 → 1.0 economy correction',
    'Vault 5 locks 8 → 7',
    'Key weights normalised',
    'Live tune: difficulty 1.05',
  ]
  const authors = ['admin', 'atakan', 'liveops-bot', 'mira', 'admin']
  for (let v = 1; v <= historyLen; v++) {
    const c = JSON.parse(JSON.stringify(cfg))
    c.version = v
    // Drift a few fields over versions so diffs look real.
    c.difficulty = Math.round((1 + (v > 5 ? 0.05 : 0) + (v > 16 ? 0.05 : 0)) * 100) / 100
    c.lootMultiplier = v >= 3 && v < 14 ? 1.1 : 1.0
    c.bustPenalty = v >= 9 ? 0.5 : 0.6
    if (v >= 4) c.vaults[2].objectives.laser = 6
    if (v >= 8) c.vaults[3].objectives.laser = 6
    if (v >= 10) c.vaults[4].weights.diamond = 18
    if (v >= 11) c.vaults[1].moves = 21
    if (v >= 15) c.vaults[4].locks = 7
    c.createdAt = new Date(createdBase.getTime() + v * 3.7 * 3600000).toISOString()
    c.createdBy = authors[v % authors.length]
    c.note = notes[(v - 1) % notes.length]
    versions.push(c)
  }

  const rec = {
    meta: { eventId, name: t.name, theme: t.theme, startsAt: start.toISOString(), endsAt: end.toISOString() },
    versions,
  }
  events.set(eventId, rec)
  return rec
}

function statusOf(meta) {
  const now = Date.now()
  const s = Date.parse(meta.startsAt)
  const e = Date.parse(meta.endsAt)
  if (now < s) return 'UPCOMING'
  if (now >= e) return 'ENDED'
  return 'ACTIVE'
}
function eventMeta(rec) {
  const latest = rec.versions[rec.versions.length - 1]
  return { ...rec.meta, status: statusOf(rec.meta), configVersion: latest.version }
}
function provision(window) {
  for (let d = -1; d <= window; d++) ensureEvent(d)
}
function findEvent(eventId) {
  provision(7)
  return events.get(eventId)
}

// ---------------------------------------------------------------------------
// Analytics — deterministic per event, scaled by how far into the day we are.
// ---------------------------------------------------------------------------
function analyticsFor(rec) {
  const meta = eventMeta(rec)
  const r = rng(fnv1a(meta.eventId + ':analytics'))
  const status = meta.status
  let progress = 1
  if (status === 'UPCOMING') progress = 0
  if (status === 'ACTIVE') {
    const s = Date.parse(meta.startsAt)
    const e = Date.parse(meta.endsAt)
    progress = Math.min(1, Math.max(0.05, (Date.now() - s) / (e - s)))
  }
  const players = Math.round((12000 + r() * 6000) * progress)
  const runsPerUser = 3.2 + r() * 1.1
  const runsStarted = Math.round(players * runsPerUser)
  const completionRate = 0.55 + r() * 0.15
  const runsCompleted = Math.round(runsStarted * completionRate)
  const escapedShare = 0.58 + r() * 0.1
  const escaped = Math.round(runsCompleted * escapedShare)
  const busted = runsCompleted - escaped
  const drop = [1, 0.78 + r() * 0.08, 0.56 + r() * 0.1, 0.33 + r() * 0.08, 0.15 + r() * 0.06]
  const vaultReached = {}
  const vaultDropoff = []
  let weighted = 0
  drop.forEach((pct, i) => {
    const reached = Math.round(runsStarted * pct)
    vaultReached[String(i + 1)] = reached
    vaultDropoff.push({ vault: i + 1, reached, pct: Math.round(pct * 1000) / 1000 })
    weighted += reached
  })
  const avgVault = runsStarted ? Math.round((weighted / runsStarted) * 10) / 10 : 0
  const avgScore = Math.round(9000 + r() * 6000)
  const aPlayers = Math.round(players * (0.49 + r() * 0.02))
  const bPlayers = players - aPlayers
  const aRpu = runsPerUser - 0.1 - r() * 0.15
  const bRpu = runsPerUser + 0.1 + r() * 0.15
  const aCr = completionRate - 0.01 - r() * 0.02
  const bCr = completionRate + 0.01 + r() * 0.02
  const grp = (p, rpu, cr) => {
    const rs = Math.round(p * rpu)
    return { players: p, runsStarted: rs, runsCompleted: Math.round(rs * cr), runsPerUser: Math.round(rpu * 100) / 100, completionRate: Math.round(cr * 1000) / 1000 }
  }
  return {
    eventId: meta.eventId,
    players,
    runsStarted,
    runsCompleted,
    completionRate: Math.round(completionRate * 1000) / 1000,
    escaped,
    busted,
    avgVault,
    avgScore,
    vaultReached,
    vaultDropoff,
    boostersUsed: { extra_moves: Math.round(runsStarted * 0.024), shield: Math.round(runsStarted * 0.007) },
    rewardsClaimed: Math.round(runsCompleted * 0.946),
    experiments: {
      lives_test: { A: grp(aPlayers, aRpu, aCr), B: grp(bPlayers, bRpu, bCr) },
    },
  }
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------
const experiments = [
  {
    id: 'lives_test',
    description: 'Max lives 5 vs 7',
    groups: { A: { maxLives: 5 }, B: { maxLives: 7 } },
    assignment: 'fnv1a(playerId) % 2',
  },
]

// ---------------------------------------------------------------------------
// Players — a few named ones plus deterministic synthesis for any plr_* id.
// ---------------------------------------------------------------------------
const players = new Map()
const NAMED = [
  ['plr_01J7ATAKAN0001', 'Atakan'],
  ['plr_01J7MIRA00002', 'Mira'],
  ['plr_01J7KENJI00003', 'Kenji'],
  ['plr_01J7SOFIA00004', 'Sofia'],
  ['plr_01J7DIEGO00005', 'Diego'],
]
function synthPlayer(playerId, displayName) {
  const r = rng(fnv1a(playerId))
  const runsN = 4 + Math.floor(r() * 16)
  const group = fnv1a(playerId) % 2 === 0 ? 'A' : 'B'
  const maxLives = group === 'A' ? 5 : 7
  const profile = {
    playerId,
    displayName: displayName || `Player ${playerId.slice(-4).toUpperCase()}`,
    coins: Math.round(200 + r() * 4000),
    lives: Math.min(maxLives, 1 + Math.floor(r() * maxLives)),
    maxLives,
    nextLifeAt: new Date(Date.now() + 8 * 60000 + Math.floor(r() * 25 * 60000)).toISOString(),
    boosters: { extra_moves: Math.floor(r() * 4), shield: Math.floor(r() * 2) },
    stats: { runs: runsN, bestScore: 0, totalLoot: 0, vaultsCracked: 0 },
    experimentGroup: group,
    version: 1 + runsN * 2 + Math.floor(r() * 5),
    createdAt: new Date(Date.now() - Math.floor(r() * 40) * 86400000).toISOString(),
  }
  provision(7)
  const ids = [...events.keys()]
  const runs = []
  let best = 0
  let loot = 0
  let cracked = 0
  for (let i = 0; i < runsN; i++) {
    const evRec = events.get(ids[Math.min(ids.length - 1, Math.floor(r() * 2))])
    const vaultReached = 1 + Math.floor(r() * 5)
    const escaped = r() > 0.4
    const vaultsCracked = escaped ? vaultReached : Math.max(0, vaultReached - 1)
    const baseLoot = Math.round(1500 * vaultsCracked + r() * 2500)
    const mult = [1, 1.5, 2, 3, 5][Math.max(0, (escaped ? vaultReached : vaultReached - 1) - 1)] || 1
    const score = Math.round(baseLoot * mult * (escaped ? 1 : 0.5))
    const startedAt = new Date(Date.now() - (i + 1) * (2 + r() * 7) * 3600000)
    const durationMs = Math.round(40000 + r() * 200000)
    runs.push({
      runId: `run_${fnv1a(playerId + i).toString(16).slice(0, 6)}`,
      eventId: evRec.meta.eventId,
      configVersion: evRec.versions[Math.floor(r() * evRec.versions.length)].version,
      status: 'FINISHED',
      outcome: escaped ? 'ESCAPED' : 'BUSTED',
      score,
      loot: baseLoot,
      vaultReached,
      vaultsCracked,
      boosters: r() > 0.7 ? ['extra_moves'] : [],
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
      durationMs,
    })
    best = Math.max(best, score)
    loot += baseLoot
    cracked += vaultsCracked
  }
  if (r() > 0.6) {
    runs.unshift({
      runId: `run_${fnv1a(playerId + 'live').toString(16).slice(0, 6)}`,
      eventId: ids[1],
      configVersion: events.get(ids[1]).versions.at(-1).version,
      status: 'ACTIVE',
      outcome: null,
      score: null,
      loot: null,
      vaultReached: null,
      vaultsCracked: null,
      boosters: [],
      startedAt: new Date(Date.now() - 4 * 60000).toISOString(),
      finishedAt: null,
      durationMs: null,
    })
  }
  profile.stats.bestScore = best
  profile.stats.totalLoot = loot
  profile.stats.vaultsCracked = cracked
  return { profile, runs: runs.slice(0, 20) }
}
function getPlayer(playerId) {
  if (players.has(playerId)) return players.get(playerId)
  const named = NAMED.find(([id]) => id === playerId)
  if (!named && !/^plr_[A-Za-z0-9]{4,}$/.test(playerId)) return null
  const p = synthPlayer(playerId, named?.[1])
  players.set(playerId, p)
  return p
}

// ---------------------------------------------------------------------------
// System / metrics
// ---------------------------------------------------------------------------
let requestsTotal = 0
const byRoute = {}
const byStatus = { '2xx': 0, '4xx': 0, '5xx': 0 }
const latencyBuckets = [5, 10, 25, 50, 100, 250, 500, 1000]
const latencyCounts = new Array(latencyBuckets.length + 1).fill(0)
function recordLatency(ms) {
  let i = latencyBuckets.findIndex((le) => ms <= le)
  if (i < 0) i = latencyBuckets.length
  latencyCounts[i]++
}
// Seed the histogram so the chart is meaningful from the first request.
;(() => {
  const r = rng(42)
  for (let i = 0; i < 5000; i++) {
    const ms = Math.pow(r(), 3) * 400 + r() * 6
    recordLatency(ms)
  }
})()

function telemetrySnapshot() {
  const t = (Date.now() - STARTED_AT) / 1000
  const depth = Math.max(0, Math.round(12 + 10 * Math.sin(t / 7) + 4 * Math.sin(t / 2.3)))
  return {
    queueDepth: depth,
    capacity: 1000,
    workers: 8,
    processed: 51201 + Math.floor(t * 14),
    dropped: 0,
    retries: 4 + Math.floor(t / 90),
  }
}
function systemPayload() {
  return {
    version: '0.1.0-mock',
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) + 5 * 3600 + 1234,
    storage: 'memory',
    cache: 'memory',
    queue: 'inline',
    telemetry: telemetrySnapshot(),
    deps: { redis: 'ok', dynamodb: 'ok', queue: 'ok' },
  }
}
function metricsPayload() {
  const t = telemetrySnapshot()
  const total = latencyCounts.reduce((a, b) => a + b, 0)
  let cum = 0
  const buckets = latencyBuckets.map((le, i) => {
    cum += latencyCounts[i]
    return { le, count: latencyCounts[i], cumulative: cum }
  })
  buckets.push({ le: '+Inf', count: latencyCounts[latencyBuckets.length], cumulative: total })
  const q = (p) => {
    let acc = 0
    for (let i = 0; i < latencyCounts.length; i++) {
      acc += latencyCounts[i]
      if (acc / total >= p) return latencyBuckets[i] ?? 1000
    }
    return 1000
  }
  return {
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) + 5 * 3600 + 1234,
    requests: { total: 184213 + requestsTotal, byStatus: { '2xx': 181004 + byStatus['2xx'], '4xx': 3111 + byStatus['4xx'], '5xx': 98 + byStatus['5xx'] }, byRoute },
    latency: { unit: 'ms', count: total, p50: q(0.5), p95: q(0.95), p99: q(0.99), buckets },
    telemetry: { queueDepth: t.queueDepth, capacity: t.capacity, dropped: t.dropped, processed: t.processed, sinkRetries: t.retries },
    rateLimiter: { rejected: 412, activeBuckets: 1387 },
    idempotency: { hits: 1290, inProgressConflicts: 3 },
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function send(res, status, body, extra = {}) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'X-Request-Id': `req_${Math.random().toString(36).slice(2, 10)}`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Request-Id, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...extra,
  })
  res.end(json)
}
function fail(res, status, code, message) {
  send(res, status, { error: { code, message } })
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  const t0 = performance.now()
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method
  const routeKey = `${method} ${path.replace(/\/(plr_|run_)[A-Za-z0-9]+/g, '/{id}').replace(/\/events\/[a-z]+_\d{4}_\d{2}_\d{2}/, '/events/{eventId}').replace(/\/config\/\d+/, '/config/{version}')}`
  byRoute[routeKey] = (byRoute[routeKey] || 0) + 1
  requestsTotal++

  res.on('finish', () => {
    recordLatency(performance.now() - t0)
    const c = res.statusCode
    byStatus[c >= 500 ? '5xx' : c >= 400 ? '4xx' : '2xx']++
    console.log(`${new Date().toISOString()} ${method} ${path} → ${c}`)
  })

  if (method === 'OPTIONS') return send(res, 204, {})

  // Simulated network latency so loading states are visible in the UI.
  await delay(90 + Math.random() * 160)

  // --- Ops -----------------------------------------------------------------
  if (path === '/healthz') return send(res, 200, { status: 'ok' })
  if (path === '/readyz') return send(res, 200, { status: 'ok', deps: { redis: 'ok', dynamodb: 'ok', queue: 'ok' } })
  if (path === '/metrics') return send(res, 200, metricsPayload())

  // --- Admin ---------------------------------------------------------------
  if (path.startsWith('/admin/')) {
    const token = req.headers['x-admin-token']
    if (!token) return fail(res, 401, 'UNAUTHORIZED', 'missing X-Admin-Token')
    if (token !== ADMIN_TOKEN) return fail(res, 403, 'FORBIDDEN', 'admin token invalid')

    let m
    if (method === 'GET' && path === '/admin/v1/events') {
      const window = Math.max(0, Math.min(30, Number(url.searchParams.get('window') || 7)))
      provision(window)
      const list = [...events.values()].map(eventMeta).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      const min = Date.now() - 2 * 86400000
      const max = Date.now() + (window + 1) * 86400000
      return send(res, 200, { events: list.filter((e) => Date.parse(e.startsAt) >= min && Date.parse(e.startsAt) <= max) })
    }
    if (method === 'POST' && path === '/admin/v1/events') {
      let body
      try {
        body = await readJson(req)
      } catch {
        return fail(res, 400, 'BAD_REQUEST', 'malformed JSON')
      }
      if (!body.eventId || !body.name || !body.startsAt || !body.endsAt) return fail(res, 400, 'BAD_REQUEST', 'missing field')
      if (events.has(body.eventId)) return fail(res, 409, 'VERSION_CONFLICT', 'event already exists')
      const cfg = { ...baseConfig(body.eventId, Math.floor(Math.random() * 0xffffffff)), ...(body.config || {}), eventId: body.eventId, version: 1, createdAt: new Date().toISOString(), createdBy: body.createdBy || 'admin', note: body.note || 'Created via admin API' }
      const rec = { meta: { eventId: body.eventId, name: body.name, theme: body.theme || 'louvre', startsAt: body.startsAt, endsAt: body.endsAt }, versions: [cfg] }
      events.set(body.eventId, rec)
      return send(res, 201, { event: eventMeta(rec), config: cfg })
    }
    if ((m = path.match(/^\/admin\/v1\/events\/([^/]+)$/)) && method === 'GET') {
      const rec = findEvent(m[1])
      if (!rec) return fail(res, 404, 'EVENT_NOT_FOUND', 'event does not exist')
      const latest = rec.versions[rec.versions.length - 1]
      return send(res, 200, {
        event: eventMeta(rec),
        config: latest,
        versions: rec.versions.map((v) => ({ version: v.version, createdAt: v.createdAt, createdBy: v.createdBy, note: v.note })).reverse(),
      })
    }
    if ((m = path.match(/^\/admin\/v1\/events\/([^/]+)\/config\/(\d+)$/)) && method === 'GET') {
      const rec = findEvent(m[1])
      if (!rec) return fail(res, 404, 'EVENT_NOT_FOUND', 'event does not exist')
      const v = rec.versions.find((x) => x.version === Number(m[2]))
      if (!v) return fail(res, 404, 'EVENT_NOT_FOUND', 'config version does not exist')
      return send(res, 200, { config: v })
    }
    if ((m = path.match(/^\/admin\/v1\/events\/([^/]+)\/config$/)) && method === 'PUT') {
      const rec = findEvent(m[1])
      if (!rec) return fail(res, 404, 'EVENT_NOT_FOUND', 'event does not exist')
      let body
      try {
        body = await readJson(req)
      } catch {
        return fail(res, 400, 'BAD_REQUEST', 'malformed JSON')
      }
      if (!body || typeof body.config !== 'object') return fail(res, 400, 'BAD_REQUEST', 'missing config')
      if (!body.note || !String(body.note).trim()) return fail(res, 400, 'BAD_REQUEST', 'missing note')
      const c = body.config
      const bad = (msg) => fail(res, 400, 'BAD_REQUEST', msg)
      if (!Array.isArray(c.vaults) || c.vaults.length < 1) return bad('vaults must be a non-empty array')
      if (!Array.isArray(c.vaultMultipliers) || c.vaultMultipliers.length !== c.vaults.length) return bad('vaultMultipliers length must equal vaults length')
      if (typeof c.difficulty !== 'number' || c.difficulty <= 0) return bad('difficulty must be > 0')
      if (typeof c.lootMultiplier !== 'number' || c.lootMultiplier <= 0) return bad('lootMultiplier must be > 0')
      if (!Number.isInteger(c.livesCost) || c.livesCost < 0) return bad('livesCost must be a non-negative integer')
      if (typeof c.bustPenalty !== 'number' || c.bustPenalty < 0 || c.bustPenalty > 1) return bad('bustPenalty must be within [0,1]')
      const latest = rec.versions[rec.versions.length - 1]
      const next = {
        ...JSON.parse(JSON.stringify(latest)),
        ...JSON.parse(JSON.stringify(c)),
        eventId: rec.meta.eventId,
        version: latest.version + 1,
        createdAt: new Date().toISOString(),
        createdBy: body.createdBy || 'admin',
        note: String(body.note).trim(),
      }
      rec.versions.push(next)
      return send(res, 201, { event: eventMeta(rec), config: next })
    }
    if ((m = path.match(/^\/admin\/v1\/events\/([^/]+)\/analytics$/)) && method === 'GET') {
      const rec = findEvent(m[1])
      if (!rec) return fail(res, 404, 'EVENT_NOT_FOUND', 'event does not exist')
      return send(res, 200, analyticsFor(rec))
    }
    if (path === '/admin/v1/experiments' && method === 'GET') return send(res, 200, { experiments })
    if ((m = path.match(/^\/admin\/v1\/players\/([^/]+)$/)) && method === 'GET') {
      const p = getPlayer(decodeURIComponent(m[1]))
      if (!p) return fail(res, 404, 'PLAYER_NOT_FOUND', 'player does not exist')
      return send(res, 200, p)
    }
    if ((m = path.match(/^\/admin\/v1\/players\/([^/]+)\/grant$/)) && method === 'POST') {
      const p = getPlayer(decodeURIComponent(m[1]))
      if (!p) return fail(res, 404, 'PLAYER_NOT_FOUND', 'player does not exist')
      let body
      try {
        body = await readJson(req)
      } catch {
        return fail(res, 400, 'BAD_REQUEST', 'malformed JSON')
      }
      const coins = Number(body.coins || 0)
      const lives = Number(body.lives || 0)
      if (!Number.isFinite(coins) || !Number.isFinite(lives)) return fail(res, 400, 'BAD_REQUEST', 'coins/lives must be numbers')
      p.profile.coins = Math.max(0, p.profile.coins + coins)
      p.profile.lives = Math.max(0, Math.min(p.profile.maxLives, p.profile.lives + lives))
      for (const [k, v] of Object.entries(body.boosters || {})) {
        p.profile.boosters[k] = Math.max(0, (p.profile.boosters[k] || 0) + Number(v || 0))
      }
      p.profile.version += 1
      return send(res, 200, { profile: p.profile })
    }
    if (path === '/admin/v1/system' && method === 'GET') return send(res, 200, systemPayload())
    return fail(res, 404, 'NOT_FOUND', `no admin route for ${method} ${path}`)
  }

  return fail(res, 404, 'NOT_FOUND', `no route for ${method} ${path}`)
})

server.listen(PORT, () => {
  console.log(`Vault Rush mock API listening on http://localhost:${PORT}`)
  console.log(`Admin token: ${ADMIN_TOKEN}`)
  provision(7)
  console.log(`Provisioned ${events.size} events; today's event: ${[...events.values()].map(eventMeta).find((e) => e.status === 'ACTIVE')?.eventId}`)
})

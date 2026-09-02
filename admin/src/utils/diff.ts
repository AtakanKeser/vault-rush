import type { EventConfig } from '../api/types'

export interface DiffEntry {
  path: string
  label: string
  before: unknown
  after: unknown
}

const IGNORED = new Set(['version', 'createdAt', 'createdBy', 'note', 'eventId'])

function flatten(value: unknown, prefix: string, out: Map<string, unknown>) {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out))
      // Record length so added/removed items surface.
      out.set(`${prefix}.length`, value.length)
      return
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!prefix && IGNORED.has(k)) continue
      flatten(v, prefix ? `${prefix}.${k}` : k, out)
    }
    return
  }
  out.set(prefix, value)
}

/** Human-friendly label for a flattened path, e.g. `vaults[3].objectives.laser` → "Vault 4 · Laser objective". */
export function labelForPath(path: string, cfg?: EventConfig | null): string {
  const vault = path.match(/^vaults\[(\d+)\]\.(.+)$/)
  if (vault) {
    const idx = Number(vault[1])
    const name = cfg?.vaults[idx]?.name
    const head = `Vault ${idx + 1}${name ? ` (${name})` : ''}`
    const rest = vault[2]
    const map: Record<string, string> = {
      name: 'Name',
      moves: 'Moves',
      locks: 'Locks',
      'objectives.key': 'Key objective',
      'objectives.laser': 'Laser objective',
      'objectives.camera': 'Camera objective',
      'weights.key': 'Key weight',
      'weights.laser': 'Laser weight',
      'weights.camera': 'Camera weight',
      'weights.money': 'Money weight',
      'weights.diamond': 'Diamond weight',
      'weights.guard': 'Guard weight',
    }
    return `${head} · ${map[rest] ?? rest}`
  }
  const mult = path.match(/^vaultMultipliers\[(\d+)\]$/)
  if (mult) return `Vault ${Number(mult[1]) + 1} multiplier`
  const map: Record<string, string> = {
    seed: 'Seed',
    difficulty: 'Difficulty',
    lootMultiplier: 'Loot multiplier',
    livesCost: 'Lives cost',
    bustPenalty: 'Bust penalty',
    'grid.w': 'Grid width',
    'grid.h': 'Grid height',
    'vaults.length': 'Number of vaults',
    'vaultMultipliers.length': 'Number of multipliers',
  }
  return map[path] ?? path
}

export function diffConfigs(before: EventConfig | null, after: EventConfig | null): DiffEntry[] {
  const a = new Map<string, unknown>()
  const b = new Map<string, unknown>()
  if (before) flatten(before, '', a)
  if (after) flatten(after, '', b)
  const keys = new Set([...a.keys(), ...b.keys()])
  const out: DiffEntry[] = []
  for (const k of keys) {
    const x = a.get(k)
    const y = b.get(k)
    if (Object.is(x, y)) continue
    if (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) < 1e-9) continue
    out.push({ path: k, label: labelForPath(k, after ?? before), before: x, after: y })
  }
  return out.sort((p, q) => p.path.localeCompare(q.path, undefined, { numeric: true }))
}

export function fmtDiffValue(v: unknown): string {
  if (v === undefined) return '∅'
  if (v === null) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
  if (typeof v === 'string') return `"${v}"`
  return JSON.stringify(v)
}

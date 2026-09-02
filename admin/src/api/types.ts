// Types mirror docs/api.md exactly. Keep in sync with the Go backend.

export type EventStatus = 'ACTIVE' | 'UPCOMING' | 'ENDED'

export interface EventMeta {
  eventId: string
  name: string
  theme: string
  status: EventStatus
  startsAt: string
  endsAt: string
  configVersion: number
}

export interface VaultObjectives {
  key: number
  laser: number
  camera: number
}

export interface TileWeights {
  key: number
  laser: number
  camera: number
  money: number
  diamond: number
  guard: number
}

export interface VaultConfig {
  name: string
  moves: number
  objectives: VaultObjectives
  locks: number
  weights: TileWeights
}

export interface EventConfig {
  eventId: string
  version: number
  seed: number
  difficulty: number
  lootMultiplier: number
  livesCost: number
  grid: { w: number; h: number }
  vaultMultipliers: number[]
  bustPenalty: number
  vaults: VaultConfig[]
  createdAt?: string
  createdBy?: string
  note?: string
}

export interface VersionMeta {
  version: number
  createdAt: string
  createdBy: string
  note: string
}

export interface EventDetailResponse {
  event: EventMeta
  config: EventConfig
  versions: VersionMeta[]
}

export interface PutConfigResponse {
  event: EventMeta
  config: EventConfig
}

export interface DropoffPoint {
  vault: number
  reached: number
  pct: number
}

export interface ExperimentGroupStats {
  players: number
  runsStarted: number
  runsCompleted: number
  runsPerUser: number
  completionRate: number
}

export interface EventAnalytics {
  eventId: string
  players: number
  runsStarted: number
  runsCompleted: number
  completionRate: number
  escaped: number
  busted: number
  avgVault: number
  avgScore: number
  vaultReached: Record<string, number>
  vaultDropoff: DropoffPoint[]
  boostersUsed: Record<string, number>
  rewardsClaimed: number
  experiments: Record<string, Record<string, ExperimentGroupStats>>
}

export interface Experiment {
  id: string
  description: string
  groups: Record<string, Record<string, unknown>>
  assignment: string
}

export interface Profile {
  playerId: string
  displayName: string
  coins: number
  lives: number
  maxLives: number
  nextLifeAt: string
  boosters: Record<string, number>
  stats: { runs: number; bestScore: number; totalLoot: number; vaultsCracked: number }
  experimentGroup: string
  version: number
  createdAt: string
}

/** Runs returned by the admin player endpoint. docs/api.md only says "last 20
 *  runs", so every field beyond runId is optional and rendered defensively. */
export interface PlayerRun {
  runId: string
  eventId?: string
  configVersion?: number
  status?: string
  outcome?: 'ESCAPED' | 'BUSTED' | null
  score?: number | null
  loot?: number | null
  vaultReached?: number | null
  vaultsCracked?: number | null
  boosters?: string[]
  startedAt?: string
  finishedAt?: string | null
  durationMs?: number | null
}

export interface PlayerResponse {
  profile: Profile
  runs: PlayerRun[]
}

export interface GrantRequest {
  coins?: number
  lives?: number
  boosters?: Record<string, number>
}

export interface TelemetryStats {
  queueDepth: number
  capacity: number
  workers: number
  processed: number
  dropped: number
  retries: number
}

export interface SystemInfo {
  version: string
  uptimeSeconds: number
  storage: string
  cache: string
  queue: string
  telemetry: TelemetryStats
  deps: Record<string, string>
}

export interface Readyz {
  status: string
  deps?: Record<string, string>
}

export interface Healthz {
  status: string
}

/** /metrics has no fixed contract; render known keys richly, the rest generically. */
export type Metrics = Record<string, unknown>

export interface ApiErrorBody {
  error: { code: string; message: string }
}

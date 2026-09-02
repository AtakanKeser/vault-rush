import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api, errorMessage } from '../api/client'
import { useAsync, useNow } from '../api/hooks'
import type { PlayerRun } from '../api/types'
import { IconGift, IconPlayers, IconRefresh, IconSearch, IconSpinner } from '../components/Icons'
import { useToast } from '../components/Toast'
import { Card, EmptyState, ErrorState, LivesPips, Pill, Skeleton, SkeletonRows } from '../components/ui'
import { fmtDateTime, fmtDuration, fmtInt, fmtRelative, titleCase } from '../utils/format'

const RECENT_KEY = 'vr_recent_players'
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
  } catch {
    return []
  }
}
function pushRecent(id: string) {
  const list = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 6)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
  return list
}

export function Players() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const [query, setQuery] = useState(routeId ?? '')
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const player = useAsync((s) => api.player(routeId!, s), [routeId], { enabled: !!routeId })
  const now = useNow(30_000)

  useEffect(() => {
    setQuery(routeId ?? '')
    if (routeId && player.data) setRecent(pushRecent(routeId))
  }, [routeId, player.data])

  function submit(e: FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (q) navigate(`/players/${encodeURIComponent(q)}`)
  }

  const notFound = player.error instanceof ApiError && player.error.status === 404
  const p = player.data?.profile

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Players</h1>
          <p className="page__subtitle">Look up a player by ID to inspect their profile, recent runs and grant currency.</p>
        </div>
        <form className="page__actions" onSubmit={submit} style={{ minWidth: 380 }}>
          <div className="input-group grow">
            <input className="input mono" placeholder="playerId, e.g. plr_01J7…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Player ID" />
            <button className="btn btn--primary" type="submit" disabled={!query.trim() || player.loading}>
              {player.loading ? <IconSpinner /> : <IconSearch />} Search
            </button>
          </div>
        </form>
      </header>

      {recent.length > 0 && (
        <div className="row row--wrap text-sm muted">
          Recent:
          {recent.map((r) => (
            <Link key={r} to={`/players/${encodeURIComponent(r)}`} className={`chip mono ${r === routeId ? 'chip--gold' : ''}`} style={{ textDecoration: 'none' }}>
              {r}
            </Link>
          ))}
        </div>
      )}

      {!routeId ? (
        <Card>
          <EmptyState icon={<IconPlayers />} title="Search for a player" message="Enter a playerId above. Results include the profile, experiment group, boosters and the last 20 runs." />
        </Card>
      ) : player.initialLoading ? (
        <div className="grid grid--1-2">
          <div className="stack">
            <Skeleton variant="block" style={{ height: 300 }} />
            <Skeleton variant="block" style={{ height: 200 }} />
          </div>
          <Card flush>
            <SkeletonRows rows={8} />
          </Card>
        </div>
      ) : notFound ? (
        <Card>
          <EmptyState icon={<IconPlayers />} title="Player not found" message={<span>No player with id <span className="mono">{routeId}</span>.</span>} />
        </Card>
      ) : player.error && !player.data ? (
        <ErrorState error={player.error} onRetry={player.reload} />
      ) : p ? (
        <div className="grid grid--1-2 fade-in">
          <div className="stack">
            <Card
              actions={
                <button className="btn btn--ghost btn--icon btn--sm" onClick={player.reload} title="Refresh" aria-label="Refresh">
                  <IconRefresh className={player.loading ? 'spin' : ''} />
                </button>
              }
              title={
                <div className="player-hero">
                  <div className="avatar">{p.displayName.slice(0, 1).toUpperCase()}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="row">
                      <span className="text-lg semibold">{p.displayName}</span>
                      <Pill tone={p.experimentGroup === 'A' ? 'sky' : 'gold'}>group {p.experimentGroup}</Pill>
                    </div>
                    <div className="mono muted text-xs truncate">{p.playerId}</div>
                  </div>
                </div>
              }
            >
              <div className="grid grid--2" style={{ gap: 8 }}>
                <div className="mini-stat">
                  <span className="mini-stat__label">Coins</span>
                  <span className="mini-stat__value" style={{ color: 'var(--gold)' }}>
                    {fmtInt(p.coins)}
                  </span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Lives</span>
                  <span className="mini-stat__value row" style={{ gap: 10 }}>
                    {p.lives}/{p.maxLives}
                    <LivesPips lives={p.lives} max={p.maxLives} />
                  </span>
                  <span className="text-xs muted">{p.lives < p.maxLives ? `next life ${fmtRelative(p.nextLifeAt, now)}` : 'full'}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Best score</span>
                  <span className="mini-stat__value">{fmtInt(p.stats.bestScore)}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Runs</span>
                  <span className="mini-stat__value">{fmtInt(p.stats.runs)}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Total loot</span>
                  <span className="mini-stat__value">{fmtInt(p.stats.totalLoot)}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Vaults cracked</span>
                  <span className="mini-stat__value">{fmtInt(p.stats.vaultsCracked)}</span>
                </div>
              </div>

              <dl className="kv">
                <dt>Boosters</dt>
                <dd>
                  <span className="chips">
                    {Object.entries(p.boosters).length === 0 && <span className="muted">none</span>}
                    {Object.entries(p.boosters).map(([k, v]) => (
                      <span className="chip" key={k}>
                        {titleCase(k)} <b>×{v}</b>
                      </span>
                    ))}
                  </span>
                </dd>
                <dt>Profile version</dt>
                <dd className="mono-num">{p.version}</dd>
                <dt>Created</dt>
                <dd>
                  {fmtDateTime(p.createdAt)} <span className="muted">· {fmtRelative(p.createdAt, now)}</span>
                </dd>
              </dl>
            </Card>

            <GrantForm playerId={p.playerId} onGranted={player.reload} />
          </div>

          <Card title="Recent runs" subtitle={`Last ${player.data!.runs.length} runs (newest first)`} flush>
            <RunsTable runs={player.data!.runs} />
          </Card>
        </div>
      ) : null}
    </div>
  )
}

function GrantForm({ playerId, onGranted }: { playerId: string; onGranted: () => void }) {
  const toast = useToast()
  const [coins, setCoins] = useState('')
  const [lives, setLives] = useState('')
  const [extraMoves, setExtraMoves] = useState('')
  const [shield, setShield] = useState('')
  const [busy, setBusy] = useState(false)

  const n = (s: string) => (s.trim() === '' ? 0 : Number(s))
  const vals = { coins: n(coins), lives: n(lives), extra_moves: n(extraMoves), shield: n(shield) }
  const anyInvalid = Object.values(vals).some((v) => !Number.isInteger(v))
  const anySet = Object.values(vals).some((v) => v !== 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (anyInvalid || !anySet) return
    setBusy(true)
    try {
      const boosters: Record<string, number> = {}
      if (vals.extra_moves) boosters.extra_moves = vals.extra_moves
      if (vals.shield) boosters.shield = vals.shield
      await api.grant(playerId, {
        ...(vals.coins ? { coins: vals.coins } : {}),
        ...(vals.lives ? { lives: vals.lives } : {}),
        ...(Object.keys(boosters).length ? { boosters } : {}),
      })
      const parts = [vals.coins && `${fmtInt(vals.coins)} coins`, vals.lives && `${vals.lives} lives`, vals.extra_moves && `${vals.extra_moves} extra moves`, vals.shield && `${vals.shield} shield`].filter(Boolean)
      toast.success('Grant applied', `${parts.join(', ')} → ${playerId}`)
      setCoins('')
      setLives('')
      setExtraMoves('')
      setShield('')
      onGranted()
    } catch (err) {
      toast.error('Grant failed', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const field = (label: string, v: string, set: (s: string) => void, hint?: string) => (
    <div className="field">
      <label className="field__label">{label}</label>
      <input className={`input ${v.trim() !== '' && !Number.isInteger(Number(v)) ? 'input--invalid' : ''}`} type="number" step={1} placeholder="0" value={v} onChange={(e) => set(e.target.value)} aria-label={label} />
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )

  return (
    <Card title="Grant" subtitle="Adds to the player's inventory via POST /admin/v1/players/{id}/grant. Negative values deduct.">
      <form className="stack" onSubmit={submit}>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {field('Coins', coins, setCoins)}
          {field('Lives', lives, setLives, 'capped at maxLives')}
          {field('Extra moves', extraMoves, setExtraMoves, 'booster')}
          {field('Shield', shield, setShield, 'booster')}
        </div>
        <div className="spread">
          <span className="text-xs muted">Grants are audited server-side.</span>
          <button className="btn btn--primary" type="submit" disabled={busy || anyInvalid || !anySet}>
            {busy ? <IconSpinner /> : <IconGift />} Grant
          </button>
        </div>
      </form>
    </Card>
  )
}

function RunsTable({ runs }: { runs: PlayerRun[] }) {
  if (!runs || runs.length === 0) return <EmptyState title="No runs yet" message="This player has not started a heist." />
  // Six columns with secondary facts stacked under the primary value, so the
  // table fits a 2/3-width card without horizontal scrolling.
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Event · config</th>
            <th>Outcome</th>
            <th className="num">Score · loot</th>
            <th className="num">Vault</th>
            <th className="num">Started · duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const active = r.status === 'ACTIVE' || (!r.outcome && !r.finishedAt)
            const boosters = r.boosters ?? []
            return (
              <tr key={r.runId}>
                <td>
                  <div className="mono">{r.runId}</div>
                  {boosters.length > 0 && <div className="text-xs" style={{ color: 'var(--gold)' }}>{boosters.map(titleCase).join(' · ')}</div>}
                </td>
                <td>
                  {r.eventId ? (
                    <Link to={`/events/${r.eventId}`} className="mono text-xs">
                      {r.eventId}
                    </Link>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {r.configVersion !== undefined && <div className="muted-2 text-xs mono-num">config v{r.configVersion}</div>}
                </td>
                <td>
                  {active ? <Pill tone="sky">in progress</Pill> : r.outcome === 'ESCAPED' ? <Pill tone="emerald">escaped</Pill> : r.outcome === 'BUSTED' ? <Pill tone="ruby">busted</Pill> : <Pill tone="neutral">{r.status ?? '—'}</Pill>}
                </td>
                <td className="num">
                  <div className="semibold">{fmtInt(r.score ?? null)}</div>
                  <div className="muted text-xs">{r.loot != null ? `${fmtInt(r.loot)} loot` : '—'}</div>
                </td>
                <td className="num">
                  {r.vaultReached != null ? (
                    <span title={`Reached vault ${r.vaultReached}, cracked ${r.vaultsCracked ?? 0}`}>
                      {r.vaultReached}
                      <span className="muted-2"> / {r.vaultsCracked ?? '–'}</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num nowrap">
                  <div className="muted">{fmtDateTime(r.startedAt)}</div>
                  <div className="muted-2 text-xs">{r.durationMs != null ? fmtDuration(r.durationMs) : active ? 'running' : '—'}</div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

import { Fragment } from 'react'
import type { DropoffPoint, EventAnalytics, ExperimentGroupStats } from '../api/types'
import { fmtInt, fmtNum, fmtPct } from '../utils/format'
import { EmptyState, KpiTile, Pill, Skeleton, SplitBar } from './ui'
import { IconExperiments, IconPulse } from './Icons'

// ---------------------------------------------------------------------------
// KPI grid shared by Overview and Event detail
// ---------------------------------------------------------------------------
export function AnalyticsKpis({ a, loading }: { a: EventAnalytics | null; loading: boolean }) {
  if (loading || !a) {
    return (
      <div className="grid grid--kpi">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} variant="tile" />
        ))}
      </div>
    )
  }
  const rpu = a.players ? a.runsStarted / a.players : 0
  const dropSeries = a.vaultDropoff.map((d) => d.pct)
  return (
    <div className="grid grid--kpi">
      <KpiTile label="Players" value={fmtInt(a.players)} tone="sky" sub={<span>{fmtNum(rpu, 2)} runs / player</span>} />
      <KpiTile label="Started runs" value={fmtInt(a.runsStarted)} tone="neutral" sub={<span>{fmtInt(a.boostersUsed?.extra_moves ?? 0)} with extra moves</span>} />
      <KpiTile label="Completed" value={fmtInt(a.runsCompleted)} tone="neutral" sub={<span>{fmtInt(a.rewardsClaimed)} rewards claimed</span>} />
      <KpiTile
        label="Completion"
        value={fmtPct(a.completionRate)}
        tone={a.completionRate >= 0.6 ? 'emerald' : a.completionRate >= 0.45 ? 'gold' : 'ruby'}
        sub={<span>{fmtInt(a.runsStarted - a.runsCompleted)} abandoned / in progress</span>}
      />
      <KpiTile label="Avg vault" value={Number.isFinite(a.avgVault) ? a.avgVault.toFixed(1) : '—'} unit={`/ ${a.vaultDropoff.length || 5}`} tone="gold" spark={dropSeries} sub={<span>reached per run</span>} />
      <KpiTile label="Avg score" value={fmtInt(a.avgScore)} tone="violet" sub={<span>per completed run</span>} />
      <div className="kpi kpi--emerald fade-in" style={{ gridColumn: 'span 2', minWidth: 0 }}>
        <div className="kpi__label">
          Escaped vs Busted
          <span className="text-xs muted-2">{fmtInt(a.runsCompleted)} completed</span>
        </div>
        <div className="kpi__value">
          <span style={{ color: 'var(--emerald)' }}>{fmtInt(a.escaped)}</span>
          <small>vs</small>
          <span style={{ color: 'var(--ruby)' }}>{fmtInt(a.busted)}</span>
        </div>
        <SplitBar a={a.escaped} b={a.busted} labelA="Escaped" labelB="Busted" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vault drop-off horizontal bars
// ---------------------------------------------------------------------------
export function DropoffChart({ points, names, loading }: { points: DropoffPoint[] | null | undefined; names?: string[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="bars">
        {Array.from({ length: 5 }).map((_, i) => (
          <div className="bar" key={i}>
            <Skeleton variant="text" style={{ width: '70%' }} />
            <Skeleton variant="text" style={{ height: 22 }} />
            <Skeleton variant="text" style={{ width: '60%', marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    )
  }
  if (!points || points.length === 0) {
    return <EmptyState icon={<IconPulse />} title="No runs yet" message="Drop-off appears once players start heists in this event." />
  }
  const sorted = [...points].sort((a, b) => a.vault - b.vault)
  const tone = (pct: number) => (pct >= 0.7 ? '' : pct >= 0.4 ? 'bar__fill--sky' : pct >= 0.2 ? 'bar__fill--violet' : 'bar__fill--ruby')
  return (
    <div className="bars">
      {sorted.map((p, i) => {
        const prev = sorted[i - 1]
        const drop = prev && prev.reached > 0 ? 1 - p.reached / prev.reached : null
        return (
          <div className="bar" key={p.vault}>
            <div className="bar__label">
              <b>Vault {p.vault}</b>
              <span className="truncate">{names?.[p.vault - 1] ?? ''}</span>
            </div>
            <div className="bar__track" title={`${fmtInt(p.reached)} runs reached vault ${p.vault}`}>
              <div className={`bar__fill ${tone(p.pct)}`} style={{ width: `${Math.max(0.5, p.pct * 100)}%`, animationDelay: `${i * 70}ms` }} />
            </div>
            <div className="bar__value">
              <span>{drop === null ? fmtInt(p.reached) : `−${fmtPct(drop, 0)}`}</span>
              <b>{fmtPct(p.pct, 0)}</b>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// A/B experiment comparison table
// ---------------------------------------------------------------------------
function delta(a: number, b: number, digits = 1) {
  if (!a) return null
  const d = ((b - a) / a) * 100
  const cls = Math.abs(d) < 0.05 ? 'delta--flat' : d > 0 ? 'delta--up' : 'delta--down'
  return <span className={`delta ${cls}`}>{d > 0 ? '+' : ''}{d.toFixed(digits)}%</span>
}

export function ExperimentTable({ experiments, loading }: { experiments: Record<string, Record<string, ExperimentGroupStats>> | null | undefined; loading?: boolean }) {
  if (loading) {
    return (
      <div>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} variant="row" />
        ))}
      </div>
    )
  }
  const ids = experiments ? Object.keys(experiments) : []
  if (ids.length === 0) {
    return <EmptyState icon={<IconExperiments />} title="No experiments" message="This event has no experiment groups reporting yet." />
  }
  // Experiment id becomes a group row; deltas vs the control group sit under the value
  // so the table stays narrow enough for a 2/5-width card.
  return (
    <div className="table-wrap">
      <table className="table table--compact">
        <thead>
          <tr>
            <th>Group</th>
            <th className="num">Players</th>
            <th className="num">Runs</th>
            <th className="num">Runs / user</th>
            <th className="num">Completion</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const groups = experiments![id]
            const names = Object.keys(groups).sort()
            const control = groups[names[0]]
            return (
              <Fragment key={id}>
                <tr className="group-row">
                  <td colSpan={5} className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    {id}
                  </td>
                </tr>
                {names.map((g, gi) => {
                  const s = groups[g]
                  const isControl = gi === 0
                  return (
                    <tr key={g}>
                      <td>
                        <span className="row">
                          <Pill tone={isControl ? 'sky' : 'gold'}>{g}</Pill>
                          {isControl && <span className="muted-2 text-xs">control</span>}
                        </span>
                      </td>
                      <td className="num">{fmtInt(s.players)}</td>
                      <td className="num">{fmtInt(s.runsStarted)}</td>
                      <td className="num">
                        <div>{fmtNum(s.runsPerUser, 2)}</div>
                        {!isControl && <div style={{ lineHeight: 1.1 }}>{delta(control.runsPerUser, s.runsPerUser)}</div>}
                      </td>
                      <td className="num">
                        <div>{fmtPct(s.completionRate)}</div>
                        {!isControl && <div style={{ lineHeight: 1.1 }}>{delta(control.completionRate, s.completionRate)}</div>}
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

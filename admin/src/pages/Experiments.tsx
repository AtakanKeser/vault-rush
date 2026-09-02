import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync } from '../api/hooks'
import type { ExperimentGroupStats } from '../api/types'
import { ExperimentTable } from '../components/Analytics'
import { IconExperiments, IconRefresh } from '../components/Icons'
import { Card, EmptyState, ErrorState, Pill, Skeleton, StatusPill } from '../components/ui'
import { fmtInt, fmtNum, fmtPct } from '../utils/format'
import { pickCurrent } from './Overview'

export function Experiments() {
  const exps = useAsync((s) => api.experiments(s), [])
  const events = useAsync((s) => api.events(7, s), [])
  const current = useMemo(() => pickCurrent(events.data?.events), [events.data])
  const id = current?.eventId ?? null
  const analytics = useAsync((s) => api.eventAnalytics(id!, s), [id], { enabled: !!id, refreshMs: 30_000 })

  const loading = exps.initialLoading
  const list = exps.data?.experiments ?? []

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Experiments</h1>
          <p className="page__subtitle row row--wrap">
            Group definitions and per-group performance
            {current && (
              <>
                <span>
                  in <Link to={`/events/${current.eventId}`}>{current.name}</Link>
                </span>
                <StatusPill status={current.status} />
              </>
            )}
          </p>
        </div>
        <div className="page__actions">
          <button
            className="btn"
            onClick={() => {
              exps.reload()
              analytics.reload()
            }}
            disabled={exps.loading || analytics.loading}
          >
            <IconRefresh className={exps.loading || analytics.loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      {exps.error && !exps.data ? (
        <ErrorState error={exps.error} onRetry={exps.reload} />
      ) : loading ? (
        <Skeleton variant="block" style={{ height: 320 }} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<IconExperiments />} title="No experiments defined" message="GET /admin/v1/experiments returned an empty list." />
        </Card>
      ) : (
        list.map((exp) => {
          const stats = analytics.data?.experiments?.[exp.id]
          const groupNames = Object.keys(exp.groups).sort()
          return (
            <Card
              key={exp.id}
              title={
                <span className="row">
                  <span className="mono">{exp.id}</span>
                  <Pill tone="violet">{groupNames.length} groups</Pill>
                </span>
              }
              subtitle={exp.description}
              actions={
                <span className="chip" title="Assignment function">
                  <span className="muted">assign</span> <span className="mono">{exp.assignment}</span>
                </span>
              }
              className="fade-in"
            >
              <div className="grid grid--1-2">
                <div className="stack">
                  <span className="section-title">Group definitions</span>
                  <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <table className="table table--compact">
                      <thead>
                        <tr>
                          <th>Group</th>
                          <th>Overrides</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupNames.map((g, i) => (
                          <tr key={g}>
                            <td>
                              <Pill tone={i === 0 ? 'sky' : 'gold'}>{g}</Pill>
                              {i === 0 && <span className="muted-2 text-xs" style={{ marginLeft: 8 }}>control</span>}
                            </td>
                            <td>
                              <span className="chips">
                                {Object.entries(exp.groups[g]).map(([k, v]) => (
                                  <span className="chip" key={k}>
                                    {k} <b>{typeof v === 'number' ? fmtNum(v) : JSON.stringify(v)}</b>
                                  </span>
                                ))}
                                {Object.keys(exp.groups[g]).length === 0 && <span className="muted-2">defaults</span>}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="stack">
                  <span className="section-title">Performance in current event</span>
                  {analytics.error && !analytics.data ? (
                    <ErrorState error={analytics.error} onRetry={analytics.reload} compact />
                  ) : !id && !events.loading ? (
                    <EmptyState title="No current event" message="Experiment analytics are scoped to an event." />
                  ) : (
                    <>
                      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                        <ExperimentTable experiments={stats ? { [exp.id]: stats } : analytics.data ? {} : null} loading={analytics.initialLoading || events.initialLoading} />
                      </div>
                      {stats && <GroupBars stats={stats} names={groupNames} />}
                    </>
                  )}
                </div>
              </div>
            </Card>
          )
        })
      )}
    </div>
  )
}

/** Side-by-side bars for the two headline metrics. */
function GroupBars({ stats, names }: { stats: Record<string, ExperimentGroupStats>; names: string[] }) {
  const groups = names.filter((g) => stats[g])
  if (groups.length === 0) return null
  const tones = ['bar__fill--sky', '', 'bar__fill--violet', 'bar__fill--emerald']
  const maxRpu = Math.max(...groups.map((g) => stats[g].runsPerUser), 0.01)
  const maxPlayers = Math.max(...groups.map((g) => stats[g].players), 1)
  const metric = (label: string, value: (s: ExperimentGroupStats) => number, max: number, fmt: (n: number) => string) => (
    <div className="stack stack--sm">
      <span className="text-xs muted upper semibold">{label}</span>
      <div className="bars" style={{ gap: 6 }}>
        {groups.map((g, i) => (
          <div className="bar" key={g} style={{ gridTemplateColumns: '28px minmax(0,1fr) 72px' }}>
            <div className="bar__label">
              <b>{g}</b>
            </div>
            <div className="bar__track" style={{ height: 14 }}>
              <div className={`bar__fill ${tones[i % tones.length]}`} style={{ width: `${(value(stats[g]) / max) * 100}%` }} />
            </div>
            <div className="bar__value">
              <b style={{ fontSize: 13, minWidth: 0 }}>{fmt(value(stats[g]))}</b>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
  return (
    <div className="grid grid--3" style={{ gap: 16 }}>
      {metric('Players', (s) => s.players, maxPlayers, fmtInt)}
      {metric('Runs / user', (s) => s.runsPerUser, maxRpu, (n) => fmtNum(n, 2))}
      {metric('Completion', (s) => s.completionRate, 1, (n) => fmtPct(n))}
    </div>
  )
}

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useNow } from '../api/hooks'
import type { EventMeta } from '../api/types'
import { AnalyticsKpis, DropoffChart, ExperimentTable } from '../components/Analytics'
import { IconArrowRight, IconEvents, IconRefresh } from '../components/Icons'
import { SystemStrip } from '../components/SystemStrip'
import { Card, EmptyState, ErrorState, Skeleton, StatusPill } from '../components/ui'
import { fmtCountdown, fmtDateTime } from '../utils/format'

/** Pick the event the dashboard should focus on: ACTIVE, else the most recent ENDED, else the next UPCOMING. */
export function pickCurrent(events: EventMeta[] | undefined | null): EventMeta | null {
  if (!events || events.length === 0) return null
  const active = events.find((e) => e.status === 'ACTIVE')
  if (active) return active
  const ended = events.filter((e) => e.status === 'ENDED').sort((a, b) => b.startsAt.localeCompare(a.startsAt))
  if (ended[0]) return ended[0]
  return [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
}

export function Overview() {
  const events = useAsync((s) => api.events(7, s), [], { refreshMs: 60_000 })
  const current = useMemo(() => pickCurrent(events.data?.events), [events.data])
  const id = current?.eventId ?? null
  const analytics = useAsync((s) => api.eventAnalytics(id!, s), [id], { enabled: !!id, refreshMs: 30_000 })
  const detail = useAsync((s) => api.event(id!, s), [id], { enabled: !!id })
  const now = useNow(1000)

  const loading = events.initialLoading || (!!id && analytics.initialLoading)
  const vaultNames = detail.data?.config.vaults.map((v) => v.name)

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Overview</h1>
          <p className="page__subtitle">
            {events.initialLoading ? (
              <Skeleton variant="text" style={{ width: 320, display: 'inline-block', verticalAlign: 'middle' }} />
            ) : current ? (
              <span className="row row--wrap">
                <span>
                  Current event: <Link to={`/events/${current.eventId}`}>{current.name}</Link>
                </span>
                <StatusPill status={current.status} />
                {current.status === 'ACTIVE' && (
                  <span className="mono-num">
                    ends in <b>{fmtCountdown(Date.parse(current.endsAt) - now)}</b>
                  </span>
                )}
                {current.status === 'UPCOMING' && <span>starts {fmtDateTime(current.startsAt)}</span>}
                <span className="muted-2">·</span>
                <span className="muted">
                  config <b style={{ color: 'var(--gold)' }}>v{current.configVersion}</b>
                </span>
              </span>
            ) : (
              'No events found'
            )}
          </p>
        </div>
        <div className="page__actions">
          <button
            className="btn"
            onClick={() => {
              events.reload()
              analytics.reload()
            }}
            disabled={analytics.loading}
          >
            <IconRefresh className={analytics.loading ? 'spin' : ''} /> Refresh
          </button>
          {current && (
            <Link className="btn btn--primary" to={`/events/${current.eventId}`}>
              Open event <IconArrowRight />
            </Link>
          )}
        </div>
      </header>

      <SystemStrip />

      {events.error && !events.data ? (
        <ErrorState error={events.error} onRetry={events.reload} />
      ) : !events.initialLoading && !current ? (
        <Card>
          <EmptyState icon={<IconEvents />} title="No events scheduled" message="The events endpoint returned an empty window. Events are auto-provisioned on read by the backend." />
        </Card>
      ) : analytics.error && !analytics.data ? (
        <ErrorState error={analytics.error} onRetry={analytics.reload} />
      ) : (
        <>
          <AnalyticsKpis a={analytics.data} loading={loading} />

          <div className="grid grid--3-2">
            <Card title="Vault drop-off" subtitle="Share of started runs that reached each vault">
              <DropoffChart points={analytics.data?.vaultDropoff} names={vaultNames} loading={loading} />
            </Card>
            <Card title="A/B experiments" subtitle="Per-group performance in the current event" flush>
              <ExperimentTable experiments={analytics.data?.experiments} loading={loading} />
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

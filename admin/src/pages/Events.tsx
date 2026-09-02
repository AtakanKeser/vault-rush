import { Fragment, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useNow } from '../api/hooks'
import type { EventMeta } from '../api/types'
import { IconChevronRight, IconEvents, IconRefresh } from '../components/Icons'
import { Card, EmptyState, ErrorState, SkeletonRows, StatusPill } from '../components/ui'
import { fmtCountdown, fmtDate, fmtDuration, fmtTime } from '../utils/format'

function utcDay(iso: string) {
  const d = new Date(iso)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function themeInitials(theme: string) {
  return theme
    .split(/[_-\s]+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function Events() {
  const { data, error, initialLoading, loading, reload } = useAsync((s) => api.events(7, s), [], { refreshMs: 60_000 })
  const navigate = useNavigate()
  const now = useNow(1000)

  const groups = useMemo(() => {
    const list = [...(data?.events ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    const today = utcDay(new Date().toISOString())
    const g: { label: string; items: EventMeta[] }[] = [
      { label: 'Yesterday', items: [] },
      { label: 'Today', items: [] },
      { label: 'Upcoming', items: [] },
    ]
    for (const e of list) {
      const d = utcDay(e.startsAt)
      if (d < today) g[0].items.push(e)
      else if (d === today) g[1].items.push(e)
      else g[2].items.push(e)
    }
    return g.filter((x) => x.items.length > 0)
  }, [data])

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Events</h1>
          <p className="page__subtitle">Daily global heists — yesterday, today and the next 7 days. Events are auto-provisioned by the backend.</p>
        </div>
        <div className="page__actions">
          <button className="btn" onClick={reload} disabled={loading}>
            <IconRefresh className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      <Card flush>
        {error && !data ? (
          <div style={{ padding: 20 }}>
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : initialLoading ? (
          <SkeletonRows rows={9} />
        ) : groups.length === 0 ? (
          <EmptyState icon={<IconEvents />} title="No events in window" message="GET /admin/v1/events?window=7 returned nothing." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Starts</th>
                  <th>Ends</th>
                  <th>Timing</th>
                  <th className="num">Config</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.label}>
                    <tr className="group-row">
                      <td colSpan={7}>{g.label}</td>
                    </tr>
                    {g.items.map((e) => {
                      const start = Date.parse(e.startsAt)
                      const end = Date.parse(e.endsAt)
                      return (
                        <tr
                          key={e.eventId}
                          className="clickable"
                          tabIndex={0}
                          onClick={() => navigate(`/events/${e.eventId}`)}
                          onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && navigate(`/events/${e.eventId}`)}
                        >
                          <td>
                            <div className="row gap-12">
                              <div className="theme-mark" style={{ width: 36, height: 36, fontSize: 13, borderRadius: 10 }}>
                                {themeInitials(e.theme)}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div className="semibold truncate">{e.name}</div>
                                <div className="mono muted-2 text-xs truncate">{e.eventId}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <StatusPill status={e.status} />
                          </td>
                          <td className="nowrap">
                            <div>{fmtDate(e.startsAt)}</div>
                            <div className="muted text-xs mono-num">{fmtTime(e.startsAt)} UTC</div>
                          </td>
                          <td className="nowrap">
                            <div>{fmtDate(e.endsAt)}</div>
                            <div className="muted text-xs mono-num">{fmtTime(e.endsAt)} UTC</div>
                          </td>
                          <td className="nowrap mono-num">
                            {e.status === 'ACTIVE' ? (
                              <span style={{ color: 'var(--emerald)' }}>ends in {fmtCountdown(end - now)}</span>
                            ) : e.status === 'UPCOMING' ? (
                              <span className="muted">starts in {fmtDuration(start - now, { compact: true })}</span>
                            ) : (
                              <span className="muted">ran {fmtDuration(end - start, { compact: true })}</span>
                            )}
                          </td>
                          <td className="num">
                            <span className="chip chip--gold">
                              v<b>{e.configVersion}</b>
                            </span>
                          </td>
                          <td className="muted-2">
                            <IconChevronRight />
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

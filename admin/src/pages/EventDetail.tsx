import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useNow } from '../api/hooks'
import type { EventConfig, PutConfigResponse } from '../api/types'
import { AnalyticsKpis, DropoffChart, ExperimentTable } from '../components/Analytics'
import { ConfigEditor, type RestoreRequest } from '../components/ConfigEditor'
import { IconArrowLeft, IconRefresh } from '../components/Icons'
import { Card, ErrorState, Skeleton, StatusPill } from '../components/ui'
import { VersionHistory } from '../components/VersionHistory'
import { fmtCountdown, fmtDateTime, fmtInt } from '../utils/format'
import { themeInitials } from './Events'

export function EventDetail() {
  const { id = '' } = useParams()
  const detail = useAsync((s) => api.event(id, s), [id])
  const analytics = useAsync((s) => api.eventAnalytics(id, s), [id], { refreshMs: 30_000 })
  const now = useNow(1000)

  // Read-only view of an older version + "restore as new version" hand-off to the editor.
  const [viewing, setViewing] = useState<number | null>(null)
  const viewed = useAsync((s) => api.eventConfigVersion(id, viewing!, s), [id, viewing], { enabled: viewing !== null })
  const [restore, setRestore] = useState<RestoreRequest | null>(null)

  useEffect(() => setViewing(null), [id])

  const onPublished = useCallback(
    (_res: PutConfigResponse) => {
      setViewing(null)
      detail.reload()
    },
    [detail],
  )

  const requestRestore = useCallback(
    async (version: number) => {
      const cfg: EventConfig = viewed.data && viewing === version ? viewed.data.config : (await api.eventConfigVersion(id, version)).config
      setRestore({ version, config: cfg, nonce: Date.now() })
      setViewing(null)
    },
    [id, viewed.data, viewing],
  )

  const ev = detail.data?.event
  const cfg = detail.data?.config ?? null
  const a = analytics.data

  return (
    <div className="page">
      <div>
        <div className="crumbs">
          <Link to="/events" className="row gap-4">
            <IconArrowLeft width={14} height={14} /> Events
          </Link>
          <span>/</span>
          <span className="mono">{id}</span>
        </div>

        {detail.error && !detail.data ? (
          <ErrorState error={detail.error} onRetry={detail.reload} />
        ) : (
          <Card>
            {!ev ? (
              <div className="event-head">
                <div className="stack stack--sm">
                  <Skeleton variant="title" style={{ width: 320 }} />
                  <Skeleton variant="text" style={{ width: 460 }} />
                </div>
                <div className="event-head__stats">
                  <Skeleton variant="tile" style={{ width: 132, height: 64 }} />
                  <Skeleton variant="tile" style={{ width: 132, height: 64 }} />
                  <Skeleton variant="tile" style={{ width: 132, height: 64 }} />
                </div>
              </div>
            ) : (
              <div className="event-head fade-in">
                <div className="row gap-16">
                  <div className="theme-mark">{themeInitials(ev.theme)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="event-head__name">
                      {ev.name}
                      <StatusPill status={ev.status} />
                    </div>
                    <div className="event-head__meta">
                      <span>
                        Theme <b>{ev.theme}</b>
                      </span>
                      <span>
                        Starts <b>{fmtDateTime(ev.startsAt)}</b>
                      </span>
                      <span>
                        Ends <b>{fmtDateTime(ev.endsAt)}</b>
                      </span>
                      {ev.status === 'ACTIVE' && (
                        <span>
                          Ends in{' '}
                          <b className="mono-num" style={{ color: 'var(--emerald)' }}>
                            {fmtCountdown(Date.parse(ev.endsAt) - now)}
                          </b>
                        </span>
                      )}
                      {ev.status === 'UPCOMING' && (
                        <span>
                          Starts in <b className="mono-num">{fmtCountdown(Date.parse(ev.startsAt) - now)}</b>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="event-head__stats">
                  <div className="stat-box stat-box--gold">
                    <span className="stat-box__label">Config version</span>
                    <span className="stat-box__value">v{ev.configVersion}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box__label">Versions</span>
                    <span className="stat-box__value">{detail.data?.versions.length ?? '—'}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box__label">Players</span>
                    <span className="stat-box__value">{a ? fmtInt(a.players) : '—'}</span>
                  </div>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>

      {detail.data && cfg && (
        <div className="grid grid--2-1">
          <ConfigEditor
            eventId={id}
            base={cfg}
            eventStatus={detail.data.event.status}
            readOnly={viewing !== null ? { version: viewing, config: viewed.data?.config ?? null, loading: viewed.loading, error: viewed.error } : null}
            onExitReadOnly={() => setViewing(null)}
            onRestore={requestRestore}
            restore={restore}
            onPublished={onPublished}
          />
          <VersionHistory versions={detail.data.versions} current={cfg.version} viewing={viewing} onView={setViewing} onRestore={requestRestore} />
        </div>
      )}

      <div className="stack">
        <div className="spread">
          <h2 className="section-title">Analytics — this event only</h2>
          <button className="btn btn--sm" onClick={analytics.reload} disabled={analytics.loading}>
            <IconRefresh className={analytics.loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
        {analytics.error && !a ? (
          <ErrorState error={analytics.error} onRetry={analytics.reload} />
        ) : (
          <>
            <AnalyticsKpis a={a} loading={analytics.initialLoading} />
            <div className="grid grid--3-2">
              <Card title="Vault drop-off" subtitle="Share of started runs that reached each vault">
                <DropoffChart points={a?.vaultDropoff} names={cfg?.vaults.map((v) => v.name)} loading={analytics.initialLoading} />
              </Card>
              <Card title="A/B experiments" subtitle="Per-group performance in this event" flush>
                <ExperimentTable experiments={a?.experiments} loading={analytics.initialLoading} />
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

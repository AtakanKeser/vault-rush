import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useNow } from '../api/hooks'
import { fmtInt } from '../utils/format'
import { HealthDot, Progress, Skeleton } from './ui'

/** Live system strip — polls /admin/v1/system every 10s. */
export function SystemStrip() {
  const { data, error, initialLoading, lastUpdated } = useAsync((s) => api.system(s), [], { refreshMs: 10_000 })
  const now = useNow(1000)

  if (initialLoading) return <Skeleton variant="block" style={{ height: 58 }} />
  if (error && !data) {
    return (
      <div className="strip">
        <div className="strip__item strip__item--grow">
          <span className="strip__label">System</span>
          <span className="strip__value">
            <HealthDot status="down" /> <span className="muted">Unable to load /admin/v1/system</span>
          </span>
        </div>
      </div>
    )
  }
  if (!data) return null
  const t = data.telemetry
  const load = t.capacity ? t.queueDepth / t.capacity : 0
  const ago = lastUpdated ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : 0
  const depsOk = Object.values(data.deps).every((v) => v === 'ok')

  return (
    <div className="strip fade-in">
      <div className="strip__item">
        <span className="strip__label">System</span>
        <span className="strip__value">
          <HealthDot status={depsOk && !error ? 'ok' : 'degraded'} pulse />
          <Link to="/system" style={{ color: 'inherit' }}>
            v{data.version}
          </Link>
        </span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Storage</span>
        <span className="strip__value">{data.storage}</span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Cache</span>
        <span className="strip__value">{data.cache}</span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Queue</span>
        <span className="strip__value">{data.queue}</span>
      </div>
      <div className="strip__item strip__item--grow" style={{ minWidth: 200 }}>
        <span className="strip__label">Telemetry queue</span>
        <span className="strip__value" style={{ gap: 12 }}>
          <span>
            {fmtInt(t.queueDepth)} <span className="muted">/ {fmtInt(t.capacity)}</span>
          </span>
          <span className="grow" style={{ maxWidth: 220 }}>
            <Progress value={t.queueDepth} max={t.capacity} tone={load > 0.8 ? 'ruby' : load > 0.5 ? 'gold' : 'sky'} />
          </span>
        </span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Dropped</span>
        <span className="strip__value" style={{ color: t.dropped > 0 ? 'var(--ruby)' : undefined }}>
          {fmtInt(t.dropped)}
        </span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Workers</span>
        <span className="strip__value">{fmtInt(t.workers)}</span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Dependencies</span>
        <span className="strip__value deps">
          {Object.entries(data.deps).map(([k, v]) => (
            <span className="dep" key={k}>
              <HealthDot status={v} /> {k}
            </span>
          ))}
        </span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Updated</span>
        <span className="strip__value muted">{ago < 2 ? 'just now' : `${ago}s ago`}</span>
      </div>
    </div>
  )
}

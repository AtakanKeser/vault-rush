import { api } from '../api/client'
import { useAsync, useNow } from '../api/hooks'
import { IconRefresh } from '../components/Icons'
import { Card, EmptyState, ErrorState, HealthDot, Pill, Progress, Skeleton, healthOf } from '../components/ui'
import { fmtDuration, fmtInt, fmtNum, titleCase } from '../utils/format'

const REFRESH = 10_000

// ---------------------------------------------------------------------------
// Loose shape guards for /metrics (no fixed contract)
// ---------------------------------------------------------------------------
interface Bucket {
  le: number | string
  count: number
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function asBuckets(v: unknown): Bucket[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const ok = v.every((b) => isRecord(b) && ('le' in b || 'upper' in b) && typeof (b.count ?? b.n) === 'number')
  if (!ok) return null
  return v.map((b) => {
    const r = b as Record<string, unknown>
    return { le: (r.le ?? r.upper) as number | string, count: (r.count ?? r.n) as number }
  })
}
function findLatency(m: Record<string, unknown>): { buckets: Bucket[]; stats: [string, number][]; unit: string } | null {
  const lat = m.latency ?? m.requestLatency ?? m.latencyMs ?? m.request_latency
  if (!isRecord(lat)) return null
  const buckets = asBuckets(lat.buckets ?? lat.histogram)
  if (!buckets) return null
  const stats: [string, number][] = []
  for (const k of ['p50', 'p90', 'p95', 'p99', 'count', 'mean', 'avg', 'max']) {
    if (typeof lat[k] === 'number') stats.push([k, lat[k] as number])
  }
  return { buckets, stats, unit: typeof lat.unit === 'string' ? lat.unit : 'ms' }
}

/** Flatten any JSON one level deeper than a table can show: nested objects become dotted keys. */
function flattenRows(v: unknown, prefix = '', depth = 0): [string, string][] {
  if (isRecord(v) && depth < 2) {
    return Object.entries(v).flatMap(([k, x]) => flattenRows(x, prefix ? `${prefix}.${k}` : k, depth + 1))
  }
  const s = typeof v === 'number' ? fmtNum(v, 3) : typeof v === 'string' ? v : JSON.stringify(v)
  return [[prefix, s]]
}

export function System() {
  const sys = useAsync((s) => api.system(s), [], { refreshMs: REFRESH })
  const ready = useAsync((s) => api.readyz(s), [], { refreshMs: REFRESH })
  const health = useAsync((s) => api.healthz(s), [], { refreshMs: REFRESH })
  const metrics = useAsync((s) => api.metrics(s), [], { refreshMs: REFRESH })
  const now = useNow(1000)

  const reloadAll = () => {
    sys.reload()
    ready.reload()
    health.reload()
    metrics.reload()
  }
  const anyLoading = sys.loading || ready.loading || metrics.loading
  const ago = sys.lastUpdated ? Math.round((now - sys.lastUpdated) / 1000) : null

  const s = sys.data
  const m = isRecord(metrics.data) ? metrics.data : null
  const latency = m ? findLatency(m) : null
  const requests = m && isRecord(m.requests) ? m.requests : null
  const knownKeys = new Set(['latency', 'requestLatency', 'latencyMs', 'request_latency', 'requests', 'uptimeSeconds'])
  const otherMetrics = m ? Object.entries(m).filter(([k]) => !knownKeys.has(k)) : []

  // Merge dependency views from /admin/v1/system and /readyz.
  const depNames = Array.from(new Set([...Object.keys(s?.deps ?? {}), ...Object.keys(ready.data?.deps ?? {})]))

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">System</h1>
          <p className="page__subtitle">
            Live view of <span className="mono">/admin/v1/system</span>, <span className="mono">/healthz</span>, <span className="mono">/readyz</span> and <span className="mono">/metrics</span> · refreshes every {REFRESH / 1000}s
            {ago !== null && <span className="muted-2"> · updated {ago < 2 ? 'just now' : `${ago}s ago`}</span>}
          </p>
        </div>
        <div className="page__actions">
          <button className="btn" onClick={reloadAll} disabled={anyLoading}>
            <IconRefresh className={anyLoading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      {sys.error && !s ? <ErrorState error={sys.error} onRetry={sys.reload} /> : null}

      <div className="grid grid--3">
        {/* Service */}
        <Card title="Service" subtitle="Build, uptime and backing modes">
          {sys.initialLoading ? (
            <Skeleton variant="block" style={{ height: 150 }} />
          ) : s ? (
            <dl className="kv fade-in">
              <dt>Version</dt>
              <dd className="mono">{s.version}</dd>
              <dt>Uptime</dt>
              <dd className="mono-num">{fmtDuration(s.uptimeSeconds * 1000)}</dd>
              <dt>Storage</dt>
              <dd>
                <Pill tone={s.storage === 'memory' ? 'gold' : 'emerald'} lower>
                  {s.storage}
                </Pill>
              </dd>
              <dt>Cache</dt>
              <dd>
                <Pill tone={s.cache === 'memory' ? 'gold' : 'emerald'} lower>
                  {s.cache}
                </Pill>
              </dd>
              <dt>Queue</dt>
              <dd>
                <Pill tone={s.queue === 'inline' ? 'gold' : 'emerald'} lower>
                  {s.queue}
                </Pill>
              </dd>
              <dt>Liveness</dt>
              <dd className="row">
                <HealthDot status={health.error ? 'down' : health.data?.status} /> {health.error ? 'unreachable' : health.data?.status ?? '—'}
              </dd>
            </dl>
          ) : (
            <EmptyState title="Unavailable" />
          )}
        </Card>

        {/* Telemetry */}
        <Card title="Telemetry pipeline" subtitle="Async event queue feeding analytics">
          {sys.initialLoading ? (
            <Skeleton variant="block" style={{ height: 150 }} />
          ) : s ? (
            <div className="stack fade-in">
              <div>
                <div className="spread text-sm" style={{ marginBottom: 6 }}>
                  <span className="muted">Queue depth</span>
                  <span className="mono-num">
                    <b>{fmtInt(s.telemetry.queueDepth)}</b> <span className="muted">/ {fmtInt(s.telemetry.capacity)}</span>
                  </span>
                </div>
                <Progress value={s.telemetry.queueDepth} max={s.telemetry.capacity} tone={s.telemetry.queueDepth / s.telemetry.capacity > 0.8 ? 'ruby' : s.telemetry.queueDepth / s.telemetry.capacity > 0.5 ? 'gold' : 'sky'} />
              </div>
              <div className="grid grid--2" style={{ gap: 8 }}>
                <div className="mini-stat">
                  <span className="mini-stat__label">Workers</span>
                  <span className="mini-stat__value">{fmtInt(s.telemetry.workers)}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Processed</span>
                  <span className="mini-stat__value">{fmtInt(s.telemetry.processed)}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Dropped</span>
                  <span className="mini-stat__value" style={{ color: s.telemetry.dropped > 0 ? 'var(--ruby)' : 'var(--emerald)' }}>
                    {fmtInt(s.telemetry.dropped)}
                  </span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat__label">Sink retries</span>
                  <span className="mini-stat__value" style={{ color: s.telemetry.retries > 0 ? 'var(--gold)' : undefined }}>
                    {fmtInt(s.telemetry.retries)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title="Unavailable" />
          )}
        </Card>

        {/* Dependencies */}
        <Card
          title="Dependencies"
          subtitle="Readiness as reported by /readyz and /admin/v1/system"
          actions={
            ready.data ? (
              <Pill tone={healthOf(ready.data.status) === 'ok' ? 'emerald' : 'ruby'} lower>
                readyz: {ready.data.status}
              </Pill>
            ) : ready.error ? (
              <Pill tone="ruby" lower>
                readyz: unreachable
              </Pill>
            ) : null
          }
        >
          {sys.initialLoading && ready.initialLoading ? (
            <Skeleton variant="block" style={{ height: 150 }} />
          ) : depNames.length === 0 ? (
            <EmptyState title="No dependencies reported" />
          ) : (
            <div className="table-wrap fade-in" style={{ margin: '0 -20px -20px', borderRadius: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Dependency</th>
                    <th>/readyz</th>
                    <th>/admin/v1/system</th>
                  </tr>
                </thead>
                <tbody>
                  {depNames.map((d) => (
                    <tr key={d}>
                      <td className="semibold">{titleCase(d)}</td>
                      <td>
                        <span className="row">
                          <HealthDot status={ready.data?.deps?.[d]} /> {ready.data?.deps?.[d] ?? <span className="muted-2">—</span>}
                        </span>
                      </td>
                      <td>
                        <span className="row">
                          <HealthDot status={s?.deps?.[d]} /> {s?.deps?.[d] ?? <span className="muted-2">—</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Metrics */}
      {metrics.error && !m ? (
        <ErrorState error={metrics.error} onRetry={metrics.reload} />
      ) : (
        <div className="grid grid--2">
          <Card
            title="Request latency"
            subtitle={latency ? `Histogram from /metrics · ${latency.unit}` : 'No latency histogram found in /metrics'}
            actions={
              latency && latency.stats.length > 0 ? (
                <div className="row gap-12 text-sm">
                  {latency.stats
                    .filter(([k]) => k.startsWith('p'))
                    .map(([k, v]) => (
                      <span key={k} className="mono-num">
                        <span className="muted">{k}</span> <b>{fmtNum(v)}</b>
                      </span>
                    ))}
                </div>
              ) : null
            }
          >
            {metrics.initialLoading ? (
              <Skeleton variant="block" style={{ height: 160 }} />
            ) : latency ? (
              <LatencyHistogram buckets={latency.buckets} unit={latency.unit} />
            ) : (
              <EmptyState title="No histogram" message="Expected metrics.latency.buckets = [{ le, count }]." />
            )}
          </Card>

          <Card title="Requests" subtitle="Counters from /metrics" flush>
            {metrics.initialLoading ? (
              <div style={{ padding: 20 }}>
                <Skeleton variant="block" style={{ height: 160 }} />
              </div>
            ) : requests ? (
              <RequestsPanel requests={requests} />
            ) : (
              <EmptyState title="No request counters" message="Expected a top-level `requests` object." />
            )}
          </Card>
        </div>
      )}

      {otherMetrics.length > 0 && (
        <Card title="Other metrics" subtitle="Everything else in /metrics, rendered generically" flush>
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Key</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {otherMetrics.flatMap(([k, v]) => flattenRows(v, k)).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="num mono-num">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

function LatencyHistogram({ buckets, unit }: { buckets: Bucket[]; unit: string }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const total = buckets.reduce((a, b) => a + b.count, 0)
  return (
    <div className="stack">
      <div className="hist">
        {buckets.map((b, i) => (
          <div className="hist__col" key={`${b.le}-${i}`}>
            <div className="hist__bar" style={{ height: `${(b.count / max) * 100}%`, animationDelay: `${i * 40}ms` }} data-count={`${fmtInt(b.count)} (${total ? ((b.count / total) * 100).toFixed(1) : 0}%)`} />
            <span className="hist__label">≤{typeof b.le === 'number' ? `${b.le}` : b.le}</span>
          </div>
        ))}
      </div>
      <div className="text-xs muted center">
        bucket upper bound ({unit}) · {fmtInt(total)} samples
      </div>
    </div>
  )
}

function RequestsPanel({ requests }: { requests: Record<string, unknown> }) {
  const total = typeof requests.total === 'number' ? requests.total : null
  const byStatus = isRecord(requests.byStatus) ? (requests.byStatus as Record<string, number>) : null
  const byRoute = isRecord(requests.byRoute) ? (requests.byRoute as Record<string, number>) : null
  const statusTotal = byStatus ? Object.values(byStatus).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0) : 0
  const color = (k: string) => (k.startsWith('5') ? 'var(--ruby)' : k.startsWith('4') ? 'var(--gold)' : 'var(--emerald)')
  const rest = Object.entries(requests).filter(([k]) => !['total', 'byStatus', 'byRoute'].includes(k))
  return (
    <div>
      <div className="stack" style={{ padding: '16px 20px' }}>
        {total !== null && (
          <div className="spread">
            <span className="muted text-sm">Total requests</span>
            <span className="text-lg semibold mono-num">{fmtInt(total)}</span>
          </div>
        )}
        {byStatus && statusTotal > 0 && (
          <div className="split">
            <div className="split__track" style={{ height: 12 }}>
              {Object.entries(byStatus).map(([k, v], i) => (
                <div key={k} className="split__seg" style={{ width: `${(v / statusTotal) * 100}%`, background: color(k), animationDelay: `${i * 80}ms` }} title={`${k}: ${fmtInt(v)}`} />
              ))}
            </div>
            <div className="row row--wrap text-sm muted" style={{ gap: 16 }}>
              {Object.entries(byStatus).map(([k, v]) => (
                <span key={k}>
                  <i className="swatch" style={{ background: color(k) }} />
                  {k} <b style={{ color: 'var(--text)' }}>{fmtInt(v)}</b>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      {byRoute && Object.keys(byRoute).length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Route</th>
                <th className="num">Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byRoute)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="num mono-num">{fmtInt(v)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {rest.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <tbody>
              {rest.flatMap(([k, v]) => flattenRows(v, k)).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="num mono-num">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

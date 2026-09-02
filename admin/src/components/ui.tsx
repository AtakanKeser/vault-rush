import type { CSSProperties, ReactNode } from 'react'
import type { EventStatus } from '../api/types'
import { errorMessage } from '../api/client'
import { IconAlert, IconRefresh } from './Icons'

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function Card({
  title,
  subtitle,
  actions,
  children,
  flush,
  divided,
  footer,
  className = '',
  style,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  flush?: boolean
  divided?: boolean
  footer?: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <section className={`card ${className}`} style={style}>
      {(title || actions) && (
        <header className={`card__header ${divided ? 'card__header--divided' : ''}`}>
          <div className="grow">
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`card__body ${flush ? 'card__body--flush' : ''}`}>{children}</div>
      {footer && <footer className="card__footer">{footer}</footer>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------
export type Tone = 'gold' | 'emerald' | 'ruby' | 'sky' | 'violet' | 'neutral'

export function KpiTile({
  label,
  value,
  unit,
  sub,
  tone = 'neutral',
  spark,
  loading,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  sub?: ReactNode
  tone?: Tone
  spark?: number[]
  loading?: boolean
}) {
  if (loading) return <Skeleton variant="tile" />
  return (
    <div className={`kpi kpi--${tone} fade-in`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub !== undefined && <div className="kpi__sub">{sub}</div>}
      {spark && spark.length > 1 && <Sparkline values={spark} className="kpi__spark" tone={tone} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pills / dots
// ---------------------------------------------------------------------------
export function StatusPill({ status }: { status: EventStatus | string }) {
  const s = String(status).toUpperCase()
  const cls = s === 'ACTIVE' ? 'pill--active' : s === 'UPCOMING' ? 'pill--upcoming' : s === 'ENDED' ? 'pill--ended' : 'pill--neutral'
  return (
    <span className={`pill ${cls}`}>
      {s === 'ACTIVE' && <span className="dot dot--ok dot--pulse" style={{ width: 6, height: 6, boxShadow: 'none' }} />}
      {s}
    </span>
  )
}

export function Pill({ tone = 'neutral', lower, children }: { tone?: Tone | 'active' | 'upcoming' | 'ended'; lower?: boolean; children: ReactNode }) {
  return <span className={`pill pill--${tone} ${lower ? 'pill--lower' : ''}`}>{children}</span>
}

export type Health = 'ok' | 'warn' | 'bad' | 'unknown'
export function healthOf(v: string | undefined | null): Health {
  if (!v) return 'unknown'
  const s = v.toLowerCase()
  if (s === 'ok' || s === 'healthy' || s === 'up' || s === 'ready') return 'ok'
  if (s === 'degraded' || s === 'warn' || s === 'warning' || s === 'slow') return 'warn'
  return 'bad'
}
export function HealthDot({ status, pulse }: { status: string | undefined | null; pulse?: boolean }) {
  const h = healthOf(status)
  return <span className={`dot dot--${h} ${pulse && h === 'ok' ? 'dot--pulse' : ''}`} title={status ?? 'unknown'} />
}

// ---------------------------------------------------------------------------
// Skeleton / empty / error
// ---------------------------------------------------------------------------
export function Skeleton({
  variant = 'text',
  className = '',
  style,
}: {
  variant?: 'text' | 'title' | 'tile' | 'block' | 'row'
  className?: string
  style?: CSSProperties
}) {
  // A span (display:block via CSS) so it is valid inside <p> and inline contexts alike.
  return <span className={`skeleton skeleton--${variant} ${className}`} style={style} aria-hidden />
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} variant="row" />
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, message, action }: { icon?: ReactNode; title: ReactNode; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {message && <div className="empty__msg">{message}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={`banner banner--error ${compact ? '' : ''}`} role="alert">
      <IconAlert style={{ color: 'var(--ruby)' }} />
      <span className="grow">{errorMessage(error)}</span>
      {onRetry && (
        <div className="banner__actions">
          <button className="btn btn--sm" onClick={onRetry}>
            <IconRefresh /> Retry
          </button>
        </div>
      )}
    </div>
  )
}

export function Banner({ tone = 'info', icon, children, actions }: { tone?: 'info' | 'warn' | 'error' | 'neutral'; icon?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`banner ${tone === 'neutral' ? '' : `banner--${tone}`}`}>
      {icon}
      <span className="grow">{children}</span>
      {actions && <div className="banner__actions">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sparkline (tiny SVG)
// ---------------------------------------------------------------------------
const toneColor: Record<Tone, string> = {
  gold: 'var(--gold)',
  emerald: 'var(--emerald)',
  ruby: 'var(--ruby)',
  sky: 'var(--sky)',
  violet: 'var(--violet)',
  neutral: 'var(--muted)',
}

export function Sparkline({
  values,
  width = 72,
  height = 26,
  tone = 'sky',
  className = '',
}: {
  values: number[]
  width?: number
  height?: number
  tone?: Tone
  className?: string
}) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pad = 2
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2)
    const y = height - pad - ((v - min) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`
  const color = toneColor[tone]
  const id = `sg-${tone}`
  return (
    <svg className={`spark ${className}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={color} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Escaped vs Busted split bar
// ---------------------------------------------------------------------------
export function SplitBar({ a, b, labelA, labelB }: { a: number; b: number; labelA: string; labelB: string }) {
  const total = a + b || 1
  const pa = (a / total) * 100
  return (
    <div className="split">
      <div className="split__track">
        <div className="split__seg" style={{ width: `${pa}%`, background: 'var(--emerald)' }} />
        <div className="split__seg" style={{ width: `${100 - pa}%`, background: 'var(--ruby)', animationDelay: '0.1s' }} />
      </div>
      <div className="split__legend">
        <span>
          <i className="swatch" style={{ background: 'var(--emerald)' }} />
          {labelA} <b>{pa.toFixed(1)}%</b>
        </span>
        <span>
          {labelB} <b>{(100 - pa).toFixed(1)}%</b>
          <i className="swatch" style={{ background: 'var(--ruby)', marginLeft: 6, marginRight: 0 }} />
        </span>
      </div>
    </div>
  )
}

export function Progress({ value, max, tone = 'sky' }: { value: number; max: number; tone?: Tone }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className="progress__fill" style={{ width: `${pct}%`, background: toneColor[tone] }} />
    </div>
  )
}

export function LivesPips({ lives, max }: { lives: number; max: number }) {
  return (
    <span className="lives" title={`${lives}/${max} lives`}>
      {Array.from({ length: Math.max(max, lives) }).map((_, i) => (
        <i key={i} className={`lives__pip ${i < lives ? 'lives__pip--on' : ''}`} />
      ))}
    </span>
  )
}

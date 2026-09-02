const intFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return intFmt.format(Math.round(n))
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return compactFmt.format(n)
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}

/** 0.618 → "61.8%" */
export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC'
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
}

/** "2h 14m", "45s", "3d 2h" */
export function fmtDuration(ms: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return opts.compact ? `${h}h ${m}m` : `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return opts.compact ? `${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** "00:42:17" style countdown */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = t - now
  const abs = Math.abs(diff)
  const unit = abs < 60_000 ? 'just now' : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`
  if (unit === 'just now') return unit
  return diff < 0 ? `${unit} ago` : `in ${unit}`
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

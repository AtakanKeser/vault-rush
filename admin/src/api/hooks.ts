import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | null
  error: unknown
  loading: boolean
  /** True on the very first fetch only (drives skeletons; later refreshes are silent). */
  initialLoading: boolean
  lastUpdated: number | null
  reload: () => void
}

interface Options {
  /** Auto-refresh interval in ms. */
  refreshMs?: number
  /** Skip fetching while false (e.g. waiting for an id). */
  enabled?: boolean
}

/**
 * Small data-fetching hook: aborts stale requests, supports polling, exposes
 * both "initialLoading" (skeletons) and "loading" (subtle refresh indicator).
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], opts: Options = {}): AsyncState<T> {
  const { refreshMs, enabled = true } = opts
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(enabled)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const hasLoadedRef = useRef(false)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    let cancelled = false
    setLoading(true)
    fnRef
      .current(ctrl.signal)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLastUpdated(Date.now())
        hasLoadedRef.current = true
      })
      .catch((e) => {
        if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return
        setError(e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled])

  useEffect(() => {
    if (!refreshMs || !enabled) return
    const id = setInterval(() => setTick((t) => t + 1), refreshMs)
    return () => clearInterval(id)
  }, [refreshMs, enabled])

  // Reset "first load" when the identity deps change so skeletons show again.
  const depsKey = JSON.stringify(deps)
  const prevKey = useRef(depsKey)
  if (prevKey.current !== depsKey) {
    prevKey.current = depsKey
    hasLoadedRef.current = false
  }

  return { data, error, loading, initialLoading: loading && !hasLoadedRef.current, lastUpdated, reload }
}

/** Re-renders every `ms` — for countdowns and "x seconds ago" labels. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

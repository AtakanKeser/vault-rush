import { useState, type FormEvent } from 'react'
import { DEFAULT_LOCAL_TOKEN, api, errorMessage } from '../api/client'
import { useAsync } from '../api/hooks'
import { useAuth } from '../auth'
import { IconKey, IconLogo, IconSpinner } from '../components/Icons'
import { HealthDot } from '../components/ui'

export function Connect() {
  const { connect } = useAuth()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const health = useAsync((s) => api.healthz(s), [], { refreshMs: 10_000 })
  const reachable = !health.error && health.data?.status === 'ok'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await connect(token)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="connect">
      <form className="connect__card" onSubmit={onSubmit}>
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand__mark">
            <IconLogo width={20} height={20} />
          </div>
          <div>
            <div className="brand__title">VAULT RUSH</div>
            <div className="brand__sub">LIVEOPS</div>
          </div>
        </div>

        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Connect to the admin API</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Enter the <span className="mono">X-Admin-Token</span> for this environment. It is stored locally in this browser only.
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="token">
            Admin token
          </label>
          <div className="input-group">
            <input
              id="token"
              className={`input ${error ? 'input--invalid' : ''}`}
              type="password"
              autoComplete="off"
              autoFocus
              placeholder="X-Admin-Token"
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setError(null)
              }}
            />
          </div>
          {error ? (
            <span className="field__error">{error}</span>
          ) : (
            <span className="connect__hint">
              Local dev token:
              <code onClick={() => setToken(DEFAULT_LOCAL_TOKEN)} title="Click to fill">
                {DEFAULT_LOCAL_TOKEN}
              </code>
            </span>
          )}
        </div>

        <button className="btn btn--primary btn--block" type="submit" disabled={busy || !token.trim()}>
          {busy ? <IconSpinner /> : <IconKey />}
          {busy ? 'Validating…' : 'Connect'}
        </button>

        <div className="spread text-xs muted" style={{ paddingTop: 4, borderTop: '1px solid var(--border)', marginTop: -8 }}>
          <span className="row">
            <HealthDot status={health.loading && !health.data ? undefined : reachable ? 'ok' : 'down'} pulse />
            {health.loading && !health.data ? 'Checking /healthz…' : reachable ? 'API reachable' : 'API unreachable — start the backend or `npm run mock`'}
          </span>
          <span className="mono">{import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL) : 'same origin'}</span>
        </div>
      </form>
    </div>
  )
}

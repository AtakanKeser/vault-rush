import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync } from '../api/hooks'
import { useAuth } from '../auth'
import { IconEvents, IconExperiments, IconLogo, IconLogout, IconOverview, IconPlayers, IconSystem } from './Icons'
import { HealthDot } from './ui'

const NAV = [
  { to: '/', label: 'Overview', icon: IconOverview, end: true },
  { to: '/events', label: 'Events', icon: IconEvents },
  { to: '/players', label: 'Players', icon: IconPlayers },
  { to: '/experiments', label: 'Experiments', icon: IconExperiments },
  { to: '/system', label: 'System', icon: IconSystem },
]

export function Layout() {
  const { disconnect } = useAuth()
  const health = useAsync((s) => api.healthz(s), [], { refreshMs: 15_000 })
  const apiStatus = health.error ? 'down' : health.data?.status ?? (health.loading ? undefined : 'down')
  const apiLabel = health.error ? 'Unreachable' : health.data?.status === 'ok' ? 'Connected' : health.data ? health.data.status : 'Checking…'

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">
            <IconLogo width={20} height={20} />
          </div>
          <div>
            <div className="brand__title">VAULT RUSH</div>
            <div className="brand__sub">LIVEOPS</div>
          </div>
        </div>

        <nav className="nav" aria-label="Main">
          <div className="nav__section">Operate</div>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="nav__link">
              <Icon className="nav__icon" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar__footer">
          <div className="conn">
            <HealthDot status={apiStatus} pulse />
            <div className="grow">
              <div className="conn__label">API</div>
              <div className="conn__value">{apiLabel}</div>
            </div>
            <button className="btn btn--ghost btn--icon btn--sm" onClick={disconnect} title="Disconnect (clear token)" aria-label="Disconnect">
              <IconLogout />
            </button>
          </div>
          <div className="text-xs muted-2 truncate" style={{ padding: '0 4px' }} title={import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL) : 'Same-origin (dev proxy)'}>
            v0.1 · {import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL) : 'same-origin proxy'}
          </div>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

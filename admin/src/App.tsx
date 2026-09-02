import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toast'
import { Connect } from './pages/Connect'
import { EventDetail } from './pages/EventDetail'
import { Events } from './pages/Events'
import { Experiments } from './pages/Experiments'
import { Overview } from './pages/Overview'
import { Players } from './pages/Players'
import { System } from './pages/System'

function Shell() {
  const { connected } = useAuth()
  if (!connected) return <Connect />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="events" element={<Events />} />
        <Route path="events/:id" element={<EventDetail />} />
        <Route path="players" element={<Players />} />
        <Route path="players/:id" element={<Players />} />
        <Route path="experiments" element={<Experiments />} />
        <Route path="system" element={<System />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ToastProvider>
  )
}

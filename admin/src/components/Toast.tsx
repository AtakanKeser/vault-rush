import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconAlert, IconCheckCircle, IconInfo, IconX } from './Icons'

type Kind = 'success' | 'error' | 'info'
interface Toast {
  id: number
  kind: Kind
  title: string
  message?: string
}
interface ToastApi {
  success: (title: string, message?: string) => void
  error: (title: string, message?: string) => void
  info: (title: string, message?: string) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (kind: Kind, title: string, message?: string) => {
      const id = ++idRef.current
      setToasts((t) => [...t.slice(-4), { id, kind, title, message }])
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 5000)
    },
    [dismiss],
  )
  const api = useMemo<ToastApi>(
    () => ({
      success: (t, m) => push('success', t, m),
      error: (t, m) => push('error', t, m),
      info: (t, m) => push('info', t, m),
    }),
    [push],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`} role="status">
            <span className="toast__icon">{t.kind === 'success' ? <IconCheckCircle /> : t.kind === 'error' ? <IconAlert /> : <IconInfo />}</span>
            <div className="toast__body">
              <div className="toast__title">{t.title}</div>
              {t.message && <div className="toast__msg">{t.message}</div>}
            </div>
            <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <IconX width={14} height={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

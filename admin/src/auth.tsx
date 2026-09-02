import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, clearToken, getToken, setToken, setUnauthorizedHandler } from './api/client'
import { useToast } from './components/Toast'

interface AuthApi {
  token: string | null
  connected: boolean
  /** Validates the token against /admin/v1/system, then stores it. Throws on failure. */
  connect: (token: string) => Promise<void>
  disconnect: () => void
}

const Ctx = createContext<AuthApi | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTok] = useState<string | null>(() => getToken())
  const toast = useToast()

  const disconnect = useCallback(() => {
    clearToken()
    setTok(null)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setTok((prev) => {
        if (prev) toast.error('Session rejected', 'The admin token was refused (401/403). Please reconnect.')
        return null
      })
    })
    return () => setUnauthorizedHandler(null)
  }, [toast])

  const connect = useCallback(async (t: string) => {
    const trimmed = t.trim()
    if (!trimmed) throw new Error('Token is required')
    await api.system(undefined, trimmed) // throws ApiError on 401/403
    setToken(trimmed)
    setTok(trimmed)
  }, [])

  const value = useMemo<AuthApi>(() => ({ token, connected: !!token, connect, disconnect }), [token, connect, disconnect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

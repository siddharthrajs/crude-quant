import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { fetchMe, login as loginRequest, updateMe, type AuthUser } from "@/lib/auth-api"

const TOKEN_STORAGE_KEY = "crude-quant-token"

interface AuthContextValue {
  user: AuthUser | null
  token: string | null
  status: "checking" | "signed-out" | "signed-in"
  error: string | null
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => void
  /** Update the signed-in user's own username/password. Requires current_password; returns the updated user. */
  updateAccount: (update: { currentPassword: string; newUsername?: string; newPassword?: string }) => Promise<AuthUser>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY))
  const [user, setUser] = useState<AuthUser | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Derived, not stored: "checking" is just "have a token, haven't resolved /me yet" --
  // keeping it derived means the effect below never needs to setState synchronously.
  const status: AuthContextValue["status"] = !token ? "signed-out" : user ? "signed-in" : "checking"

  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetchMe(token)
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        if (cancelled) return
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        setToken(null)
        setUser(null)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const signIn = useCallback(async (username: string, password: string) => {
    setError(null)
    try {
      const { access_token } = await loginRequest(username, password)
      const me = await fetchMe(access_token)
      localStorage.setItem(TOKEN_STORAGE_KEY, access_token)
      setToken(access_token)
      setUser(me)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed")
      throw err
    }
  }, [])

  const signOut = useCallback(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    setToken(null)
    setUser(null)
  }, [])

  const updateAccount = useCallback(
    async (update: { currentPassword: string; newUsername?: string; newPassword?: string }) => {
      if (!token) throw new Error("Not signed in")
      const { user: updated, access_token } = await updateMe(token, update)
      localStorage.setItem(TOKEN_STORAGE_KEY, access_token)
      setToken(access_token)
      setUser(updated)
      return updated
    },
    [token],
  )

  const value = useMemo(
    () => ({ user, token, status, error, signIn, signOut, updateAccount }),
    [user, token, status, error, signIn, signOut, updateAccount],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider")
  return ctx
}

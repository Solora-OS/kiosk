"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  api,
  tokenStore,
  type ClaimInviteInput,
  type Household,
  type SignInInput,
  type SignUpInput,
  type User,
} from "./api"
import { kioskConfig } from "./kiosk"
import { startKioskStatusTracking, stopKioskStatusTracking } from "./kiosk-status"

type AuthStatus = "loading" | "authed" | "guest"

type AuthContextValue = {
  status: AuthStatus
  user: User | null
  household: Household | null
  signUp: (input: SignUpInput) => Promise<void>
  signIn: (input: SignInInput) => Promise<void>
  /** Whether Apple OAuth sign-in is available (Neon adapter only). */
  appleEnabled: boolean
  signInWithApple: () => Promise<void>
  claimInvite: (input: ClaimInviteInput) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading")
  const [user, setUser] = useState<User | null>(null)
  const [household, setHousehold] = useState<Household | null>(null)

  const applySession = useCallback((u: User | null, h: Household | null) => {
    setUser(u)
    setHousehold(h)
    setStatus(u ? "authed" : "guest")

    // Start / stop kiosk heartbeat tracking when session changes.
    if (u && h && kioskConfig.enabled) {
      startKioskStatusTracking(h.id, "Kiosk Display").catch((err) =>
        console.error("[auth] Failed to start kiosk status tracking:", err),
      )
    } else {
      stopKioskStatusTracking()
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const session = await api.getSession()
      if (session) applySession(session.user, session.household)
      else {
        tokenStore.clear()
        applySession(null, null)
      }
    } catch {
      tokenStore.clear()
      applySession(null, null)
    }
  }, [applySession])

  useEffect(() => {
    void refresh().then(async () => {
      // If in kiosk mode and auto-signin is enabled, ask the local hub server
      // to perform sign-in using credentials stored securely on the hub machine.
      // Credentials are NEVER bundled into the frontend — the server reads them
      // from ~/.solora/kiosk-autologin.json and returns a session token.
      if (kioskConfig.autoSignIn && status === "loading") {
        try {
          const res = await api.kioskAutoSignIn()
          if (res) applySession(res.user, res.household)
        } catch (err) {
          console.error("[auth] Kiosk auto sign-in failed:", err)
        }
      }
    })
  }, [refresh, applySession, status])

  const signUp = useCallback(
    async (input: SignUpInput) => {
      const res = await api.signUp(input)
      applySession(res.user, res.household)
    },
    [applySession],
  )

  const signIn = useCallback(
    async (input: SignInInput) => {
      const res = await api.signIn(input)
      applySession(res.user, res.household)
    },
    [applySession],
  )

  const signInWithApple = useCallback(async () => {
    if (!api.signInWithApple) throw new Error("Apple sign-in isn't available.")
    // Redirects the browser to Apple; the session is resolved on return via refresh().
    await api.signInWithApple()
  }, [])

  const claimInvite = useCallback(
    async (input: ClaimInviteInput) => {
      const res = await api.claimInvite(input)
      applySession(res.user, res.household)
    },
    [applySession],
  )

  const signOut = useCallback(async () => {
    try {
      await api.signOut()
    } finally {
      applySession(null, null)
    }
  }, [applySession])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      household,
      signUp,
      signIn,
      appleEnabled: !!api.signInWithApple,
      signInWithApple,
      claimInvite,
      signOut,
      refresh,
    }),
    [status, user, household, signUp, signIn, signInWithApple, claimInvite, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

/**
 * Like {@link useAuth} but safe to call when there is no AuthProvider (e.g. the
 * kiosk experience, which has no user session). Returns null instead of throwing.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext)
}

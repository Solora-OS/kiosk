// ---------------------------------------------------------------------------
// account.ts — Solora account sign-in against central (replaces supabase.ts).
//
// Central is the identity provider. It returns a short-lived access token,
// which the hub verifies offline (server/src/lib/account-tokens.ts), and a
// refresh token that local-api.ts swaps for a new access token on a 401.
// ---------------------------------------------------------------------------

const CENTRAL_API_URL = ((import.meta.env.VITE_CENTRAL_API_URL as string | undefined) ?? "http://localhost:4000")
  .replace(/\/$/, "")

export type AccountSession = {
  access_token:  string
  refresh_token: string
  /** Unix seconds */
  expires_at:    number
  user:          { id: string; email: string; name: string }
}

export class AccountError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${CENTRAL_API_URL}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AccountError("Couldn't reach Solora. Check the connection and try again.", 0)
  }
  if (res.status === 204) return undefined as T
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new AccountError(data.error ?? `Request failed (${res.status})`, res.status)
  return data
}

export function signUp(input: { email: string; password: string; name: string }): Promise<AccountSession> {
  return post("/auth/signup", input)
}

export function signIn(input: { email: string; password: string }): Promise<AccountSession> {
  return post("/auth/login", input)
}

/** Signs in, or creates the account if the email is new (invite claim). */
export async function signInOrSignUp(input: { email: string; password: string; name: string }): Promise<AccountSession> {
  try {
    return await signUp(input)
  } catch (err) {
    if (err instanceof AccountError && err.status === 409) return signIn(input)
    throw err
  }
}

export function refresh(refreshToken: string): Promise<AccountSession> {
  return post("/auth/refresh", { refresh_token: refreshToken })
}

export async function signOut(refreshToken: string): Promise<void> {
  await post("/auth/logout", { refresh_token: refreshToken })
}

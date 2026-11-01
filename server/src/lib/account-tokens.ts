/**
 * account-tokens.ts — verifies user access tokens issued by Lumora central.
 *
 * Central is the identity provider (it replaced Supabase Auth). It signs
 * access tokens with ES256 and publishes the public keys at
 * `${CENTRAL_API_URL}/.well-known/jwks.json`. The hub fetches that once and
 * caches keys by `kid`, so verification after that is local and works while
 * the internet is down — only a key the hub has never seen needs central.
 */

import crypto, { type KeyObject } from "crypto"
import jwt from "jsonwebtoken"

const CENTRAL_API_URL = (process.env.CENTRAL_API_URL ?? "http://localhost:4000").replace(/\/$/, "")

const ISSUER   = "lumora-central"
const AUDIENCE = "lumora-users"

export interface AccountTokenPayload {
  sub:   string   // central account UUID
  email: string
  name:  string
}

const keyCache = new Map<string, KeyObject>()
let lastFetch = 0

async function fetchJwks(): Promise<void> {
  // An unknown kid shouldn't let every request hammer central.
  if (Date.now() - lastFetch < 30_000) return
  lastFetch = Date.now()
  const res = await fetch(`${CENTRAL_API_URL}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const { keys } = (await res.json()) as { keys: Array<crypto.JsonWebKey & { kid: string }> }
  for (const jwk of keys) {
    keyCache.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }))
  }
}

async function getSigningKey(kid: string): Promise<KeyObject | null> {
  if (keyCache.has(kid)) return keyCache.get(kid)!
  try {
    await fetchJwks()
  } catch (err) {
    console.warn("[auth] Could not fetch central signing keys:", (err as Error).message)
  }
  return keyCache.get(kid) ?? null
}

/** True if the token claims to be a central account token (cheap, unverified). */
export function isAccountToken(token: string): boolean {
  try {
    const raw = jwt.decode(token) as Record<string, unknown> | null
    return raw?.iss === ISSUER && raw?.aud === AUDIENCE
  } catch {
    return false
  }
}

/** Verify a central access token. Returns null if invalid, expired or unverifiable. */
export async function verifyAccountToken(token: string): Promise<AccountTokenPayload | null> {
  const decoded = jwt.decode(token, { complete: true })
  const kid = decoded?.header?.kid
  if (decoded?.header?.alg !== "ES256" || !kid) return null

  const key = await getSigningKey(kid)
  if (!key) return null
  try {
    const payload = jwt.verify(token, key, { algorithms: ["ES256"], issuer: ISSUER, audience: AUDIENCE }) as Record<string, unknown>
    if (typeof payload.sub !== "string") return null
    return {
      sub:   payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      name:  typeof payload.name === "string" ? payload.name : "",
    }
  } catch {
    return null
  }
}

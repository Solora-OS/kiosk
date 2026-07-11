/**
 * supabase.ts — server-side Supabase client for the hub.
 *
 * Used to verify Supabase user JWTs and provision local user records
 * on first sign-in. Requires SUPABASE_URL + SUPABASE_ANON_KEY in server/.env.
 *
 * Newer Supabase projects sign access tokens with an asymmetric key (ES256)
 * rather than the legacy shared HS256 "JWT Secret", so verification fetches
 * the project's public JWKS (`/auth/v1/.well-known/jwks.json`) once and
 * caches the keys by `kid` — verification after that is local and offline,
 * matching the legacy HS256 path's offline-capable design. SUPABASE_JWT_SECRET
 * is kept as a fallback for projects still on the legacy shared secret.
 */

import { createClient } from "@supabase/supabase-js"
import crypto, { type KeyObject } from "crypto"
import jwt from "jsonwebtoken"

const SUPABASE_URL     = process.env.SUPABASE_URL      ?? ""
const SUPABASE_ANON    = process.env.SUPABASE_ANON_KEY ?? ""
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? ""

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: false },
})

export interface SupabaseTokenPayload {
  sub: string        // Supabase user UUID
  email?: string
  user_metadata?: { name?: string; full_name?: string }
  role?: string
  iat?: number
  exp?: number
}

// ---------------------------------------------------------------------------
// JWKS (asymmetric signing keys) — cached in memory by `kid`.
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, KeyObject>()

async function fetchJwks(): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const { keys } = (await res.json()) as { keys: Array<Record<string, unknown> & { kid: string }> }
  for (const jwk of keys) {
    jwksCache.set(jwk.kid, crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKeyInput, format: "jwk" }))
  }
}

/** Returns the cached public key for `kid`, fetching (and caching) the JWKS if it's not yet known. */
async function getSigningKey(kid: string): Promise<KeyObject | null> {
  if (jwksCache.has(kid)) return jwksCache.get(kid)!
  try {
    await fetchJwks()
  } catch {
    return null
  }
  return jwksCache.get(kid) ?? null
}

/**
 * Verify a Supabase access token locally (offline-capable once the signing
 * key is cached). Falls back to a Supabase API call if local verification
 * isn't possible (e.g. unknown `kid` and JWKS is unreachable).
 */
export async function verifySupabaseToken(token: string): Promise<SupabaseTokenPayload | null> {
  const decoded = jwt.decode(token, { complete: true })
  const alg = decoded?.header?.alg
  const kid = decoded?.header?.kid

  if (alg === "HS256" && SUPABASE_JWT_SECRET) {
    try {
      return jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ["HS256"] }) as SupabaseTokenPayload
    } catch {
      return null
    }
  }

  if ((alg === "ES256" || alg === "RS256") && kid) {
    const key = await getSigningKey(kid)
    if (key) {
      try {
        return jwt.verify(token, key, { algorithms: [alg] }) as SupabaseTokenPayload
      } catch {
        return null
      }
    }
  }

  // Fallback: hit the Supabase API (requires internet)
  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) return null
    return {
      sub:   data.user.id,
      email: data.user.email,
      user_metadata: data.user.user_metadata as SupabaseTokenPayload["user_metadata"],
      role:  "authenticated",
    }
  } catch {
    return null
  }
}

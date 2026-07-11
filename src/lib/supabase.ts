// ---------------------------------------------------------------------------
// supabase.ts — used only for authentication (sign up / sign in / sign out).
//
// All data flow still goes through the local Express server (local-api.ts).
// Supabase is the identity provider: the client authenticates here to get an
// access_token, then exchanges it with the hub server (POST /auth/session)
// to provision/resolve the local household + member record.
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

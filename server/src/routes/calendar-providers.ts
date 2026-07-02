// ---------------------------------------------------------------------------
// /api/v1/calendar-providers — manage connected Google / Microsoft calendars
//
// iOS sends the PKCE auth code to POST /:provider/exchange. The server does
// the token exchange using the client secret (never exposed to the frontend).
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { syncHousehold } from "../services/calendar-sync"
import { writeLog } from "./activity-logs"
import { encryptToken, decryptToken } from "../lib/token-crypto"

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID ?? ""
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ""
const MICROSOFT_CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID ?? ""
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? ""
const MICROSOFT_TENANT_ID     = process.env.MICROSOFT_TENANT_ID ?? "common"

const router = Router()
router.use(requireAuth)

type ProviderRow = {
  id: string
  household_id: string
  provider: string
  access_token: string
  refresh_token: string | null
  expires_at: number | null
  email: string | null
  connected_at: string
}

function rowToPublic(r: ProviderRow) {
  return {
    provider: r.provider,
    email: r.email,
    connectedAt: r.connected_at,
  }
}

// GET /api/v1/calendar-providers
// Returns the list of connected providers (no tokens exposed).
router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM calendar_providers WHERE household_id = ?")
    .all(householdId) as ProviderRow[]
  res.json(rows.map(rowToPublic))
})

// POST /api/v1/calendar-providers/:provider/tokens
// iOS sends the tokens it obtained via PKCE. Body:
//   { access_token, refresh_token?, expires_at?, email? }
// POST /api/v1/calendar-providers/:provider/exchange
// iOS sends { code, code_verifier, redirect_uri }.
// Server exchanges for tokens using the client secret, then stores them.
router.post("/:provider/exchange", async (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { provider } = req.params

  if (!["google", "microsoft"].includes(provider)) {
    res.status(400).json({ error: "Unsupported provider." })
    return
  }

  const { code, code_verifier, redirect_uri } = req.body as {
    code?: string
    code_verifier?: string
    redirect_uri?: string
  }

  if (!code || !code_verifier || !redirect_uri) {
    res.status(400).json({ error: "code, code_verifier, and redirect_uri are required." })
    return
  }

  try {
    type TokenJson = {
      access_token: string
      refresh_token?: string
      expires_in?: number
      id_token?: string
      error_description?: string
    }

    let tokenRes: Response | globalThis.Response
    if (provider === "google") {
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        res.status(500).json({ error: "Google credentials not configured on server." })
        return
      }
      tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri,
          grant_type: "authorization_code",
          code_verifier,
        }),
      })
    } else {
      if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
        res.status(500).json({ error: "Microsoft credentials not configured on server." })
        return
      }
      tokenRes = await fetch(
        `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: MICROSOFT_CLIENT_ID,
            client_secret: MICROSOFT_CLIENT_SECRET,
            redirect_uri,
            grant_type: "authorization_code",
            code_verifier,
            scope: "Calendars.Read offline_access openid email",
          }),
        },
      )
    }

    const json = (await (tokenRes as globalThis.Response).json()) as TokenJson
    if (!(tokenRes as globalThis.Response).ok) {
      res.status(400).json({ error: json.error_description ?? "Token exchange failed." })
      return
    }

    // Decode email from id_token if present.
    let email: string | null = null
    if (json.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(json.id_token.split(".")[1], "base64").toString("utf8"),
        ) as { email?: string }
        email = payload.email ?? null
      } catch { /* ignore */ }
    }

    const expiresAt = json.expires_in
      ? Math.floor(Date.now() / 1000) + json.expires_in - 60
      : null

    // Upsert into calendar_providers.
    const db = getDb()
    const existing = db
      .prepare("SELECT id FROM calendar_providers WHERE household_id=? AND provider=?")
      .get(householdId, provider) as { id: string } | undefined

    const encAccessToken  = encryptToken(json.access_token)
    const encRefreshToken = json.refresh_token ? encryptToken(json.refresh_token) : null

    if (existing) {
      db.prepare(
        `UPDATE calendar_providers SET access_token=?, refresh_token=?, expires_at=?, email=? WHERE id=?`,
      ).run(encAccessToken, encRefreshToken, expiresAt, email, existing.id)
    } else {
      db.prepare(
        `INSERT INTO calendar_providers (id, household_id, provider, access_token, refresh_token, expires_at, email)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(uuidv4(), householdId, provider, encAccessToken, encRefreshToken, expiresAt, email)
    }

    void syncHousehold(householdId).catch(() => {})

    const row = db
      .prepare("SELECT * FROM calendar_providers WHERE household_id=? AND provider=?")
      .get(householdId, provider) as { provider: string; email: string | null; connected_at: string }

    if (!existing) {
      writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "provider.connect", resourceType: "calendar_provider", resourceName: `${provider} (${row.email ?? ""})` })
    }

    res.status(existing ? 200 : 201).json({
      provider: row.provider,
      email: row.email,
      connectedAt: row.connected_at,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error."
    res.status(500).json({ error: msg })
  }
})

router.post("/:provider/tokens", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { provider } = req.params

  if (!["google", "microsoft"].includes(provider)) {
    res.status(400).json({ error: "Unsupported provider." })
    return
  }

  const { access_token, refresh_token, expires_at, email } = req.body as {
    access_token?: string
    refresh_token?: string
    expires_at?: number
    email?: string
  }

  if (!access_token) {
    res.status(400).json({ error: "access_token is required." })
    return
  }

  const db = getDb()
  const existing = db
    .prepare("SELECT id FROM calendar_providers WHERE household_id=? AND provider=?")
    .get(householdId, provider) as { id: string } | undefined

  const encAccessToken  = encryptToken(access_token)
  const encRefreshToken = refresh_token ? encryptToken(refresh_token) : null

  if (existing) {
    db.prepare(
      `UPDATE calendar_providers
       SET access_token=?, refresh_token=?, expires_at=?, email=?
       WHERE id=?`,
    ).run(encAccessToken, encRefreshToken, expires_at ?? null, email ?? null, existing.id)
  } else {
    db.prepare(
      `INSERT INTO calendar_providers (id, household_id, provider, access_token, refresh_token, expires_at, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      householdId,
      provider,
      encAccessToken,
      encRefreshToken,
      expires_at ?? null,
      email ?? null,
    )
  }

  // Kick off an immediate sync for this household (non-blocking).
  void syncHousehold(householdId).catch(() => {})

  const row = db
    .prepare("SELECT * FROM calendar_providers WHERE household_id=? AND provider=?")
    .get(householdId, provider) as ProviderRow

  res.status(existing ? 200 : 201).json(rowToPublic(row))
})

// DELETE /api/v1/calendar-providers/:provider
// Disconnects a provider and removes its events from the events table.
router.delete("/:provider", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { provider } = req.params

  const db = getDb()
  db.prepare("DELETE FROM events WHERE household_id=? AND source=?").run(householdId, provider)
  db.prepare("DELETE FROM calendar_providers WHERE household_id=? AND provider=?").run(householdId, provider)
  writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "provider.disconnect", resourceType: "calendar_provider", resourceName: provider })
  res.status(204).end()
})

// POST /api/v1/calendar-providers/sync
router.post("/sync", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  void syncHousehold(householdId).catch(() => {})
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Provider calendar / category list endpoints
// These proxy to Google / Microsoft to return what's available for mapping.
// ---------------------------------------------------------------------------

async function getValidToken(householdId: string, provider: "google" | "microsoft"): Promise<string | null> {
  const db = getDb()
  const row = db
    .prepare("SELECT * FROM calendar_providers WHERE household_id=? AND provider=?")
    .get(householdId, provider) as ProviderRow | undefined
  if (!row) return null
  const nowSec = Math.floor(Date.now() / 1000)
  // Decrypt before use
  if (row.expires_at && row.expires_at > nowSec) return decryptToken(row.access_token)
  // Refresh if needed
  try {
    if (provider === "google") {
      if (!row.refresh_token) return null
      const refreshToken = decryptToken(row.refresh_token)
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
      })
      if (!res.ok) return null
      const json = (await res.json()) as { access_token: string; expires_in: number }
      const expiresAt = Math.floor(Date.now() / 1000) + json.expires_in - 60
      db.prepare("UPDATE calendar_providers SET access_token=?, expires_at=? WHERE id=?").run(encryptToken(json.access_token), expiresAt, row.id)
      return json.access_token
    } else {
      if (!row.refresh_token) return null
      const refreshToken = decryptToken(row.refresh_token)
      const res = await fetch(`https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, client_secret: MICROSOFT_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token", scope: "Calendars.Read offline_access" }),
      })
      if (!res.ok) return null
      const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
      const expiresAt = Math.floor(Date.now() / 1000) + json.expires_in - 60
      const encNewRefresh = json.refresh_token ? encryptToken(json.refresh_token) : null
      db.prepare("UPDATE calendar_providers SET access_token=?, refresh_token=COALESCE(?,refresh_token), expires_at=? WHERE id=?").run(encryptToken(json.access_token), encNewRefresh, expiresAt, row.id)
      return json.access_token
    }
  } catch { return null }
}

// GET /api/v1/calendar-providers/google/external-calendars
// Returns the user's Google Calendar list for mapping.
router.get("/google/external-calendars", async (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.status(403).json({ error: "No household." }); return }
  const token = await getValidToken(householdId, "google")
  if (!token) { res.status(404).json({ error: "Google not connected." }); return }
  const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100", {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) { res.status(502).json({ error: "Google calendar list fetch failed." }); return }
  const json = (await r.json()) as { items: Array<{ id: string; summary: string; backgroundColor?: string }> }
  res.json((json.items ?? []).map((c) => ({ id: c.id, name: c.summary, color: c.backgroundColor })))
})

// GET /api/v1/calendar-providers/microsoft/external-calendars
// Returns the user's Outlook categories for mapping.
router.get("/microsoft/external-calendars", async (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.status(403).json({ error: "No household." }); return }
  const token = await getValidToken(householdId, "microsoft")
  if (!token) { res.status(404).json({ error: "Microsoft not connected." }); return }
  const r = await fetch("https://graph.microsoft.com/v1.0/me/outlook/masterCategories", {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) { res.status(502).json({ error: "Microsoft categories fetch failed." }); return }
  const json = (await r.json()) as { value: Array<{ id: string; displayName: string; color?: string }> }
  res.json((json.value ?? []).map((c) => ({ id: c.displayName, name: c.displayName, color: c.color })))
})

// ---------------------------------------------------------------------------
// Preview events — called by the iOS wizard to show upcoming events
// ---------------------------------------------------------------------------

// GET /api/v1/calendar-providers/google/calendars/:calendarId/events
router.get("/google/calendars/:calendarId/events", async (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.status(403).json({ error: "No household." }); return }
  const token = await getValidToken(householdId, "google")
  if (!token) { res.status(404).json({ error: "Google not connected." }); return }
  const calendarId = req.params.calendarId as string
  const timeMin = new Date().toISOString()
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=30&timeMin=${timeMin}&orderBy=startTime&singleEvents=true`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) { res.status(502).json({ error: "Google events fetch failed." }); return }
  type GEvent = { id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }
  const json = (await r.json()) as { items: GEvent[] }
  res.json((json.items ?? []).map((e) => ({
    id: e.id,
    title: e.summary ?? "(No title)",
    start: e.start.dateTime ?? e.start.date ?? "",
    end: e.end.dateTime ?? e.end.date ?? "",
    allDay: !e.start.dateTime,
  })))
})

// GET /api/v1/calendar-providers/microsoft/calendars/:category/events
// :category is the Outlook category displayName (URI-encoded).
router.get("/microsoft/calendars/:category/events", async (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.status(403).json({ error: "No household." }); return }
  const token = await getValidToken(householdId, "microsoft")
  if (!token) { res.status(404).json({ error: "Microsoft not connected." }); return }
  // Escape single quotes per OData spec ('' = escaped ') to prevent filter injection.
  const category = decodeURIComponent(req.params.category as string).replace(/'/g, "''")
  const timeMin = new Date().toISOString()
  const filter = `categories/any(a:a eq '${category}') and end/dateTime ge '${timeMin}'`
  const select = "id,subject,start,end,isAllDay"
  const url = `https://graph.microsoft.com/v1.0/me/events?$filter=${encodeURIComponent(filter)}&$top=30&$orderby=start/dateTime&$select=${select}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) { res.status(502).json({ error: "Microsoft events fetch failed." }); return }
  type MEvent = { id: string; subject?: string; start: { dateTime: string }; end: { dateTime: string }; isAllDay?: boolean }
  const json = (await r.json()) as { value: MEvent[] }
  res.json((json.value ?? []).map((e) => ({
    id: e.id,
    title: e.subject ?? "(No title)",
    start: e.start.dateTime,
    end: e.end.dateTime,
    allDay: e.isAllDay ?? false,
  })))
})

// ---------------------------------------------------------------------------
// Excluded events — events opted out during the import wizard
// ---------------------------------------------------------------------------

// GET /api/v1/calendar-providers/excluded-events
router.get("/excluded-events", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.json([]); return }
  type Row = { provider: string; external_event_id: string }
  const rows = getDb()
    .prepare("SELECT provider, external_event_id FROM calendar_excluded_events WHERE household_id = ?")
    .all(householdId) as Row[]
  res.json(rows.map((r) => ({ provider: r.provider, eventId: r.external_event_id })))
})

// PUT /api/v1/calendar-providers/excluded-events
// Replaces the full exclusion list for a provider.
router.put("/excluded-events", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.status(403).json({ error: "No household." }); return }
  const items = req.body as Array<{ provider: string; eventId: string }>
  if (!Array.isArray(items)) { res.status(400).json({ error: "Body must be an array." }); return }

  const db = getDb()
  const providers = [...new Set(items.map((i) => i.provider))]
  const del = db.prepare("DELETE FROM calendar_excluded_events WHERE household_id=? AND provider=?")
  const ins = db.prepare(
    `INSERT OR IGNORE INTO calendar_excluded_events (id, household_id, provider, external_event_id)
     VALUES (?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const p of providers) del.run(householdId, p)
    for (const item of items) {
      if (!item.provider || !item.eventId) continue
      ins.run(uuidv4(), householdId, item.provider, item.eventId)
    }
  })()
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Mappings CRUD
// ---------------------------------------------------------------------------

// GET /api/v1/calendar-providers/mappings
router.get("/mappings", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.json([]); return }
  type Row = { id: string; provider: string; external_id: string; external_name: string; calendar_id: string | null }
  const rows = getDb()
    .prepare("SELECT * FROM calendar_provider_mappings WHERE household_id = ?")
    .all(householdId) as Row[]
  res.json(rows.map((r) => ({ id: r.id, provider: r.provider, externalId: r.external_id, externalName: r.external_name, calendarId: r.calendar_id })))
})

// PUT /api/v1/calendar-providers/mappings
router.put("/mappings", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  if (!householdId) { res.status(403).json({ error: "No household." }); return }
  const items = req.body as Array<{ provider: string; externalId: string; externalName: string; calendarId?: string | null }>
  if (!Array.isArray(items)) { res.status(400).json({ error: "Body must be an array." }); return }

  const db = getDb()
  const upsert = db.prepare(
    `INSERT INTO calendar_provider_mappings (id, household_id, provider, external_id, external_name, calendar_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(household_id, provider, external_id) DO UPDATE SET
       external_name = excluded.external_name,
       calendar_id   = excluded.calendar_id`,
  )
  const run = db.transaction(() => {
    for (const item of items) {
      if (!item.provider || !item.externalId) continue
      upsert.run(uuidv4(), householdId, item.provider, item.externalId, item.externalName ?? item.externalId, item.calendarId ?? null)
    }
  })
  run()
  res.json({ ok: true })
})

export { router as calendarProvidersRouter }

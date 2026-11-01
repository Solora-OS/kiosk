/**
 * /api/v1/seasons — the looks a household shares.
 *
 *   GET /  { holidays, themes }  which holidays the family celebrates, and imported themes
 *   PUT /  (admins, the Hub permission, the wall) replace both
 *
 * The apps decide each day's season from the holidays; themes are small JSON
 * files someone imported, kept here so every phone and the wall can use them.
 */

import { Router, type Request, type Response } from "express"
import { getDb, parseJson } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { manages } from "../lib/household-member"

const router = Router()
router.use(requireAuth)

export const HOLIDAY_IDS = ["christmas", "halloween", "valentines", "pink-october", "ramadan", "eid-al-adha", "easter", "hanukkah", "diwali", "lunar-new-year"]
const DEFAULT_HOLIDAYS = ["christmas", "halloween", "valentines", "pink-october"]
const EFFECTS = ["none", "snow", "leaves", "hearts", "embers"]
const MAX_THEMES = 12

type Theme = Record<string, unknown>
export type SeasonSettings = { holidays: string[]; themes: Theme[] }

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")

/** An imported theme, keeping only the fields the apps read. Null if it's not usable. */
function cleanTheme(t: unknown): Theme | null {
  if (!t || typeof t !== "object") return null
  const r = t as Theme
  const accent = r.accent as Theme | undefined
  const name = str(r.name, 32).trim()
  const id = str(r.id, 60)
  if (!name || !id.startsWith("custom-") || !accent || !str(accent.light, 80) || !str(accent.dark, 80)) return null
  const svg = typeof r.ornamentSvg === "string" && r.ornamentSvg.trim().startsWith("<svg") && r.ornamentSvg.length <= 60_000 ? r.ornamentSvg : undefined
  return {
    id, name, tagline: str(r.tagline, 80),
    accent: { light: str(accent.light, 80), dark: str(accent.dark, 80) },
    tint: typeof r.tint === "number" && Number.isFinite(r.tint) ? ((r.tint % 360) + 360) % 360 : 80,
    effect: EFFECTS.includes(r.effect as string) ? r.effect : "none",
    ornament: svg ? "custom" : "none",
    ...(svg ? { ornamentSvg: svg } : {}),
    imported: true,
  }
}

export function seasonSettings(householdId: string): SeasonSettings {
  const row = getDb().prepare("SELECT season_settings FROM households WHERE id = ?").get(householdId) as { season_settings: string | null } | undefined
  const saved = parseJson<Partial<SeasonSettings> | null>(row?.season_settings, null)
  return {
    holidays: Array.isArray(saved?.holidays) ? saved!.holidays.filter((h) => HOLIDAY_IDS.includes(h)) : DEFAULT_HOLIDAYS,
    themes: Array.isArray(saved?.themes) ? saved!.themes : [],
  }
}

router.get("/", (req: Request, res: Response) => {
  res.json(seasonSettings((req as AuthRequest).user.householdId!))
})

router.put("/", (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!manages(user, "hub")) { res.status(403).json({ error: "Ask a parent to change the house's seasons." }); return }
  const body = req.body as Partial<SeasonSettings>
  const current = seasonSettings(user.householdId!)
  const holidays = Array.isArray(body.holidays) ? [...new Set(body.holidays.filter((h) => HOLIDAY_IDS.includes(h)))] : current.holidays
  const themes = Array.isArray(body.themes) ? body.themes.map(cleanTheme).filter((t): t is Theme => !!t) : current.themes
  if (themes.length > MAX_THEMES) { res.status(400).json({ error: `A house can keep up to ${MAX_THEMES} themes.` }); return }
  const next = { holidays, themes }
  getDb().prepare("UPDATE households SET season_settings = ? WHERE id = ?").run(JSON.stringify(next), user.householdId)
  broadcast(user.householdId!, "households:updated", {} as never)
  res.json(next)
})

export { router as seasonsRouter }

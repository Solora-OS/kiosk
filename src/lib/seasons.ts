/**
 * Seasons — Solora's theming layer.
 *
 * The base UI is deliberately colorless (paper / graphite). A season supplies
 * the one accent color, a hue tint for the paper, an optional ambient effect
 * and the ornaments drawn into the status strip, rail and system screens.
 *
 * "auto" picks a season from the calendar. Families can also pin one, or
 * import their own as a small JSON file (see `parseSeasonFile`).
 */

export type SeasonEffect = "none" | "snow" | "leaves" | "hearts" | "embers"

/** Built-in ornament sets, drawn by components/season/ornaments.tsx */
export type OrnamentKind =
  | "none"
  | "web"
  | "lights"
  | "ribbon"
  | "leaves"
  | "hearts"
  | "stars"
  | "sprout"
  | "custom"

export type Season = {
  id: string
  name: string
  /** One line shown on boot / lock screens. */
  tagline: string
  /** Accent for light mode and dark mode (any CSS color). */
  accent: { light: string; dark: string }
  /** Hue (0-360) the paper/graphite is very faintly tinted toward. */
  tint: number
  effect: SeasonEffect
  ornament: OrnamentKind
  /** Imported themes only: an SVG drawn as an <img> (scripts can't run). */
  ornamentSvg?: string
  imported?: boolean
}

export const BUILTIN_SEASONS: Season[] = [
  {
    id: "lumen",
    name: "Lumen",
    tagline: "Good to see you.",
    accent: { light: "oklch(0.66 0.15 58)", dark: "oklch(0.76 0.13 66)" },
    tint: 80,
    effect: "none",
    ornament: "none",
  },
  {
    id: "halloween",
    name: "Halloween",
    tagline: "Something's lurking on the calendar.",
    accent: { light: "oklch(0.66 0.18 46)", dark: "oklch(0.74 0.17 52)" },
    tint: 300,
    effect: "embers",
    ornament: "web",
  },
  {
    id: "pink-october",
    name: "Pink October",
    tagline: "October is Breast Cancer Awareness Month.",
    accent: { light: "oklch(0.64 0.16 355)", dark: "oklch(0.75 0.13 355)" },
    tint: 355,
    effect: "none",
    ornament: "ribbon",
  },
  {
    id: "harvest",
    name: "Harvest",
    tagline: "Grateful for this table.",
    accent: { light: "oklch(0.58 0.13 45)", dark: "oklch(0.7 0.12 55)" },
    tint: 60,
    effect: "leaves",
    ornament: "leaves",
  },
  {
    id: "christmas",
    name: "Christmas",
    tagline: "Merry everything.",
    accent: { light: "oklch(0.54 0.17 25)", dark: "oklch(0.68 0.16 25)" },
    tint: 160,
    effect: "snow",
    ornament: "lights",
  },
  {
    id: "new-year",
    name: "New Year",
    tagline: "A clean page.",
    accent: { light: "oklch(0.68 0.12 85)", dark: "oklch(0.8 0.11 88)" },
    tint: 85,
    effect: "none",
    ornament: "stars",
  },
  {
    id: "winter",
    name: "Winter",
    tagline: "Stay warm in there.",
    accent: { light: "oklch(0.58 0.09 235)", dark: "oklch(0.74 0.08 230)" },
    tint: 230,
    effect: "snow",
    ornament: "none",
  },
  {
    id: "valentines",
    name: "Valentine's",
    tagline: "Love lives here.",
    accent: { light: "oklch(0.58 0.19 15)", dark: "oklch(0.7 0.16 12)" },
    tint: 10,
    effect: "hearts",
    ornament: "hearts",
  },
  {
    id: "spring",
    name: "Spring",
    tagline: "Windows open.",
    accent: { light: "oklch(0.6 0.13 145)", dark: "oklch(0.74 0.12 145)" },
    tint: 130,
    effect: "none",
    ornament: "sprout",
  },
  {
    id: "summer",
    name: "Summer",
    tagline: "Long days ahead.",
    accent: { light: "oklch(0.62 0.12 210)", dark: "oklch(0.76 0.1 205)" },
    tint: 95,
    effect: "none",
    ornament: "none",
  },
  // Holidays whose dates move every year (see MOVING_DATES). Off until a family turns them on.
  {
    id: "ramadan",
    name: "Ramadan",
    tagline: "Ramadan Kareem.",
    accent: { light: "oklch(0.5 0.12 268)", dark: "oklch(0.74 0.1 265)" },
    tint: 262,
    effect: "none",
    ornament: "stars",
  },
  {
    id: "eid",
    name: "Eid",
    tagline: "Eid Mubarak.",
    accent: { light: "oklch(0.56 0.12 165)", dark: "oklch(0.74 0.11 160)" },
    tint: 160,
    effect: "none",
    ornament: "stars",
  },
  {
    id: "easter",
    name: "Easter",
    tagline: "Happy Easter.",
    accent: { light: "oklch(0.6 0.12 310)", dark: "oklch(0.76 0.1 305)" },
    tint: 300,
    effect: "none",
    ornament: "sprout",
  },
  {
    id: "hanukkah",
    name: "Hanukkah",
    tagline: "Happy Hanukkah.",
    accent: { light: "oklch(0.54 0.14 255)", dark: "oklch(0.74 0.11 250)" },
    tint: 245,
    effect: "none",
    ornament: "lights",
  },
  {
    id: "diwali",
    name: "Diwali",
    tagline: "Happy Diwali.",
    accent: { light: "oklch(0.68 0.16 62)", dark: "oklch(0.78 0.14 68)" },
    tint: 60,
    effect: "embers",
    ornament: "lights",
  },
  {
    id: "lunar-new-year",
    name: "Lunar New Year",
    tagline: "Happy New Year.",
    accent: { light: "oklch(0.55 0.19 28)", dark: "oklch(0.7 0.16 30)" },
    tint: 28,
    effect: "none",
    ornament: "lights",
  },
]

/**
 * Holidays a family can turn on or off. The four on by default are the ones
 * Solora has always shown; the rest wait to be chosen.
 */
export const HOLIDAYS: { id: string; label: string; when: string; on: boolean }[] = [
  { id: "christmas", label: "Christmas", when: "December 1–26", on: true },
  { id: "halloween", label: "Halloween", when: "October 20–31", on: true },
  { id: "valentines", label: "Valentine's", when: "February 7–14", on: true },
  { id: "pink-october", label: "Pink October", when: "Breast Cancer Awareness Month", on: true },
  { id: "ramadan", label: "Ramadan and Eid al-Fitr", when: "Moves with the moon", on: false },
  { id: "eid-al-adha", label: "Eid al-Adha", when: "Moves with the moon", on: false },
  { id: "easter", label: "Easter", when: "Holy Week to Easter Monday", on: false },
  { id: "hanukkah", label: "Hanukkah", when: "Eight nights", on: false },
  { id: "diwali", label: "Diwali", when: "Five days", on: false },
  { id: "lunar-new-year", label: "Lunar New Year", when: "New Year's Eve and the week after", on: false },
]

export const DEFAULT_HOLIDAYS = HOLIDAYS.filter((h) => h.on).map((h) => h.id)

/**
 * Start dates of holidays that move, through 2032. Islamic dates depend on the
 * moon being sighted and can land a day either side. Hanukkah is the date of
 * the first night; Diwali and Lunar New Year the main day.
 */
const MOVING_DATES: Record<string, string[]> = {
  ramadan: ["2026-02-18", "2027-02-08", "2028-01-28", "2029-01-16", "2030-01-06", "2030-12-26", "2031-12-15", "2032-12-04"],
  "eid-al-adha": ["2026-05-27", "2027-05-16", "2028-05-05", "2029-04-24", "2030-04-13", "2031-04-02", "2032-03-22"],
  hanukkah: ["2026-12-04", "2027-12-24", "2028-12-12", "2029-12-01", "2030-12-20", "2031-12-09", "2032-11-27"],
  diwali: ["2026-11-08", "2027-10-29", "2028-10-17", "2029-11-05", "2030-10-26", "2031-11-14", "2032-11-02"],
  "lunar-new-year": ["2026-02-17", "2027-02-06", "2028-01-26", "2029-02-13", "2030-02-03", "2031-01-23", "2032-02-11"],
}

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return isoOf(d)
}

/** Easter Sunday (Western), by the anonymous Gregorian algorithm. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** Whether `iso` falls `before` days ahead of to `after` days past one of `starts`. */
const near = (iso: string, starts: string[], before: number, after: number) =>
  starts.some((s) => iso >= shift(s, -before) && iso <= shift(s, after))

/** The moving-holiday season on `iso`, if the family celebrates one then. */
function movingSeason(iso: string, holidays: string[]): string | null {
  const on = (id: string) => holidays.includes(id)
  if (on("ramadan")) {
    // Eid al-Fitr: the three days after 29 days of fasting (a day either way with the moon).
    if (near(iso, MOVING_DATES.ramadan.map((s) => shift(s, 29)), 0, 2)) return "eid"
    if (near(iso, MOVING_DATES.ramadan, 0, 28)) return "ramadan"
  }
  if (on("eid-al-adha") && near(iso, MOVING_DATES["eid-al-adha"], 0, 2)) return "eid"
  if (on("easter")) {
    const easter = easterSunday(Number(iso.slice(0, 4)))
    if (iso >= shift(easter, -7) && iso <= shift(easter, 1)) return "easter"
  }
  if (on("hanukkah") && near(iso, MOVING_DATES.hanukkah, 0, 8)) return "hanukkah"
  if (on("diwali") && near(iso, MOVING_DATES.diwali, 2, 2)) return "diwali"
  if (on("lunar-new-year") && near(iso, MOVING_DATES["lunar-new-year"], 1, 6)) return "lunar-new-year"
  return null
}

/**
 * The season "auto" resolves to on a given day, for a family celebrating
 * `holidays` (ids from HOLIDAYS). Holidays the family turned off fall back to
 * the time of year.
 */
export function seasonForDate(d: Date, holidays: string[] = DEFAULT_HOLIDAYS): string {
  const m = d.getMonth() // 0-based
  const day = d.getDate()
  const md = (m + 1) * 100 + day // e.g. 1031
  const on = (id: string) => holidays.includes(id)

  // Christmas Eve and Day stay Christmas for families who keep both it and Hanukkah.
  if (on("christmas") && md >= 1224 && md <= 1226) return "christmas"
  const moving = movingSeason(isoOf(d), holidays)
  if (moving) return moving
  if (md >= 1227 || md <= 102) return "new-year"
  if (md >= 1201) return on("christmas") ? "christmas" : "winter"
  if (m === 10) return "harvest" // November, through Thanksgiving
  if (md >= 1020 && on("halloween")) return "halloween"
  if (m === 9) return on("pink-october") ? "pink-october" : "harvest"
  if (md >= 207 && md <= 214 && on("valentines")) return "valentines"
  if (m <= 1) return "winter"
  if (m >= 2 && m <= 4) return "spring"
  if (m >= 5 && m <= 7) return "summer"
  return "harvest" // September
}

// ── Imported seasons ────────────────────────────────────────────────────────

const EFFECTS: SeasonEffect[] = ["none", "snow", "leaves", "hearts", "embers"]

function isColor(v: unknown): v is string {
  return typeof v === "string" && v.length < 80 && CSS.supports("color", v)
}

/**
 * Parse a user-supplied theme file. Shape:
 *
 *   {
 *     "name": "Go Team",
 *     "accent": "#1e6bd6"              // or { "light": "...", "dark": "..." }
 *     "tint": 250,                     // optional hue 0-360
 *     "effect": "snow",                // none | snow | leaves | hearts | embers
 *     "tagline": "Game day.",          // optional
 *     "ornament": "<svg …>…</svg>"     // optional, shown in the corner
 *   }
 */
export function parseSeasonFile(text: string): Season {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("That file isn't valid JSON.")
  }
  if (!raw || typeof raw !== "object") throw new Error("Theme file is empty.")

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 32) : null
  if (!name) throw new Error("Theme needs a \"name\".")

  let light: string | undefined
  let dark: string | undefined
  if (isColor(raw.accent)) {
    light = dark = raw.accent
  } else if (raw.accent && typeof raw.accent === "object") {
    const a = raw.accent as Record<string, unknown>
    if (isColor(a.light)) light = a.light
    if (isColor(a.dark)) dark = a.dark
    light ??= dark
    dark ??= light
  }
  if (!light || !dark) throw new Error("Theme needs a valid \"accent\" color.")

  const tint = typeof raw.tint === "number" && Number.isFinite(raw.tint) ? ((raw.tint % 360) + 360) % 360 : 80
  const effect = EFFECTS.includes(raw.effect as SeasonEffect) ? (raw.effect as SeasonEffect) : "none"
  const tagline = typeof raw.tagline === "string" ? raw.tagline.slice(0, 80) : ""

  let ornamentSvg: string | undefined
  if (typeof raw.ornament === "string" && raw.ornament.trim().startsWith("<svg")) {
    if (raw.ornament.length > 60_000) throw new Error("Ornament SVG is too large (60 KB max).")
    ornamentSvg = raw.ornament
  }

  return {
    id: `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    tagline,
    accent: { light, dark },
    tint,
    effect,
    ornament: ornamentSvg ? "custom" : "none",
    ornamentSvg,
    imported: true,
  }
}

/** An example file families can start from (offered as a download in Settings). */
export const SEASON_TEMPLATE = JSON.stringify(
  {
    name: "Game Day",
    accent: { light: "#1f5fbf", dark: "#7aa7ff" },
    tint: 250,
    effect: "none",
    tagline: "Go team.",
    ornament: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='30' fill='none' stroke='#1f5fbf' stroke-width='2'/></svg>",
  },
  null,
  2,
)

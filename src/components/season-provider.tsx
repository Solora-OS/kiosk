import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { BUILTIN_SEASONS, seasonForDate, type Season } from "@/lib/seasons"
import { saveHouseholdSeasons, useHouseholdSeasons } from "@/lib/household-seasons"

const MODE_KEY = "lumora-season"
const IMPORTED_KEY = "lumora-season-imported"
const EFFECTS_KEY = "lumora-season-effects"

type SeasonContextValue = {
  /** "auto" or a pinned season id. */
  mode: string
  season: Season
  seasons: Season[]
  /** Holidays this household celebrates (HOLIDAYS ids), which "auto" follows. */
  holidays: string[]
  effectsOn: boolean
  setMode: (mode: string) => void
  setEffectsOn: (on: boolean) => void
  /** Add a theme for the whole house; "device" if only this device could keep it (hub out of reach). */
  importSeason: (season: Season) => Promise<"house" | "device">
  removeSeason: (id: string) => Promise<void>
}

const SeasonContext = createContext<SeasonContextValue | undefined>(undefined)

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — keep in memory */
  }
}

/** Re-evaluate "auto" at midnight so the hub rolls into the next season by itself. */
function useToday() {
  const [today, setToday] = useState(() => new Date())
  useEffect(() => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
    const t = setTimeout(() => setToday(new Date()), next.getTime() - now.getTime())
    return () => clearTimeout(t)
  }, [today])
  return today
}

export function SeasonProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<string>(() => read(MODE_KEY, "auto"))
  const [imported, setImported] = useState<Season[]>(() => read(IMPORTED_KEY, []))
  const [effectsOn, setEffectsState] = useState<boolean>(() => read(EFFECTS_KEY, true))
  const today = useToday()

  const household = useHouseholdSeasons()
  // Built-ins, then the household's shared themes, then any kept only on this device.
  const seasons = useMemo(() => {
    const shared = household.themes.filter((t) => !BUILTIN_SEASONS.some((b) => b.id === t.id))
    const local = imported.filter((t) => !shared.some((h) => h.id === t.id))
    return [...BUILTIN_SEASONS, ...shared, ...local]
  }, [household.themes, imported])
  const season = useMemo(() => {
    const id = mode === "auto" ? seasonForDate(today, household.holidays) : mode
    return seasons.find((s) => s.id === id) ?? BUILTIN_SEASONS[0]
  }, [mode, seasons, today, household.holidays])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.season = season.id
    root.style.setProperty("--season-l", season.accent.light)
    root.style.setProperty("--season-d", season.accent.dark)
    root.style.setProperty("--tint", String(season.tint))
  }, [season])

  const setMode = useCallback((m: string) => {
    write(MODE_KEY, m)
    setModeState(m)
  }, [])

  const setEffectsOn = useCallback((on: boolean) => {
    write(EFFECTS_KEY, on)
    setEffectsState(on)
  }, [])

  const keepOnDevice = useCallback((s: Season) => {
    setImported((prev) => {
      const next = [...prev.filter((p) => p.id !== s.id), s]
      write(IMPORTED_KEY, next)
      return next
    })
  }, [])

  const importSeason = useCallback(async (s: Season): Promise<"house" | "device"> => {
    try {
      await saveHouseholdSeasons({ themes: [...household.themes.filter((t) => t.id !== s.id), s] })
      return "house"
    } catch {
      keepOnDevice(s)
      return "device"
    }
  }, [household.themes, keepOnDevice])

  const removeSeason = useCallback(
    async (id: string) => {
      if (household.themes.some((t) => t.id === id)) await saveHouseholdSeasons({ themes: household.themes.filter((t) => t.id !== id) })
      setImported((prev) => {
        const next = prev.filter((p) => p.id !== id)
        write(IMPORTED_KEY, next)
        return next
      })
      if (mode === id) setMode("auto")
    },
    [mode, setMode, household.themes],
  )

  return (
    <SeasonContext.Provider
      value={{ mode, season, seasons, holidays: household.holidays, effectsOn, setMode, setEffectsOn, importSeason, removeSeason }}
    >
      {children}
    </SeasonContext.Provider>
  )
}

export function useSeason() {
  const ctx = useContext(SeasonContext)
  if (!ctx) throw new Error("useSeason must be used within a SeasonProvider")
  return ctx
}

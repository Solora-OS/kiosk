// ---------------------------------------------------------------------------
// household-seasons.ts
//
// The seasons a whole household shares, saved on the hub: which holidays the
// family celebrates (so "auto" shows Ramadan or Hanukkah when it's time), and
// themes someone imported, which every phone and the wall can then pick.
// Each device still chooses for itself between "auto" and a pinned look.
//
// Kept identical in mobile/ and kiosk/. Each app's API module registers how
// to save to its hub; its store hands over what the hub sent.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react"
import { DEFAULT_HOLIDAYS, HOLIDAYS, type Season } from "./seasons"

export type HouseholdSeasons = { holidays: string[]; themes: Season[] }

const KEY = "solora.householdSeasons"
const EMPTY: HouseholdSeasons = { holidays: DEFAULT_HOLIDAYS, themes: [] }

function load(): HouseholdSeasons {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<HouseholdSeasons>) } : EMPTY
  } catch {
    return EMPTY
  }
}

let current = load()
const listeners = new Set<() => void>()
let saver: ((data: HouseholdSeasons) => Promise<HouseholdSeasons>) | null = null

/** What the hub sent (snapshot or save reply). Null leaves the defaults. */
export function setHouseholdSeasons(data: Partial<HouseholdSeasons> | null | undefined): void {
  if (!data) return
  const known = new Set(HOLIDAYS.map((h) => h.id))
  current = {
    holidays: Array.isArray(data.holidays) ? data.holidays.filter((h) => known.has(h)) : current.holidays,
    themes: Array.isArray(data.themes) ? data.themes.map((t) => ({ ...t, imported: true })) : current.themes,
  }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* kept for this visit */ }
  for (const fn of listeners) fn()
}

export function getHouseholdSeasons(): HouseholdSeasons {
  return current
}

export function useHouseholdSeasons(): HouseholdSeasons {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
}

/** Each app's API module says how to save to its hub. */
export function registerSeasonSaver(fn: (data: HouseholdSeasons) => Promise<HouseholdSeasons>): void {
  saver = fn
}

/** Save a change for the whole household. Throws if the hub refuses or can't be reached. */
export async function saveHouseholdSeasons(patch: Partial<HouseholdSeasons>): Promise<void> {
  if (!saver) throw new Error("Not connected to a hub.")
  const next = await saver({ ...current, ...patch })
  setHouseholdSeasons(next)
}

/**
 * display-prefs.ts — how this wall display looks and behaves, set in
 * Settings › Display. Per display (a kitchen and a living-room screen can
 * differ) and kept in this device's localStorage; anything unreadable falls
 * back to the defaults.
 */

import { useEffect, useState } from "react"
import type { TabKey } from "./store"

export type TextSize = "s" | "m" | "l" | "xl"

/** Nights on the wall: dark between two times ("22:00" to "06:30" crosses midnight). */
export type QuietHours = { on: boolean; from: string; until: string; style: "dim" | "off" }

export type DisplayPrefs = {
  /** Scales every rem in the app. */
  textSize: TextSize
  clock24: boolean
  /** Confetti when chores and lists are finished. */
  celebrations: boolean
  /** Where the wall opens, and returns to after being left alone. */
  startTab: TabKey
  /** Minutes untouched before going back to the start screen; null = stay put. */
  returnAfterMins: number | null
  /** Side-menu tabs to hide (Home and Settings always show). */
  hiddenTabs: TabKey[]
  /** Dark at night: a dim clock or the screen off, until someone taps. */
  quiet: QuietHours
}

export const DEFAULT_PREFS: DisplayPrefs = {
  textSize: "m",
  clock24: false,
  celebrations: true,
  startTab: "home",
  returnAfterMins: 3,
  hiddenTabs: [],
  quiet: { on: false, from: "22:00", until: "06:30", style: "dim" },
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** Whether `now` falls in quiet hours. Equal times mean never. */
export function inQuietHours(q: QuietHours, now: Date = new Date()): boolean {
  if (!q.on) return false
  const t = now.getHours() * 60 + now.getMinutes()
  const from = minutesOf(q.from)
  const until = minutesOf(q.until)
  if (from === until) return false
  return from < until ? t >= from && t < until : t >= from || t < until
}

const KEY = "solora.display.prefs"
const SCALE: Record<TextSize, string> = { s: "87.5%", m: "100%", l: "112.5%", xl: "125%" }

let current: DisplayPrefs = load()
const listeners = new Set<(p: DisplayPrefs) => void>()

function load(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const saved = JSON.parse(raw) as Partial<DisplayPrefs>
    return { ...DEFAULT_PREFS, ...saved, quiet: { ...DEFAULT_PREFS.quiet, ...saved.quiet } }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Applies what needs to happen outside React (the root font size). Call once at startup too. */
export function applyDisplayPrefs(p: DisplayPrefs = current): void {
  if (typeof document !== "undefined") document.documentElement.style.fontSize = SCALE[p.textSize]
}

export function getDisplayPrefs(): DisplayPrefs {
  return current
}

export function setDisplayPrefs(patch: Partial<DisplayPrefs>): void {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* applies until reload */ }
  applyDisplayPrefs(current)
  for (const fn of listeners) fn(current)
}

export function useDisplayPrefs(): DisplayPrefs {
  const [prefs, setPrefs] = useState(current)
  useEffect(() => {
    listeners.add(setPrefs)
    return () => { listeners.delete(setPrefs) }
  }, [])
  return prefs
}

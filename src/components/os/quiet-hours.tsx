"use client"

import { useEffect, useRef, useState } from "react"
import { getBrightness, setBrightness, sleepDisplay } from "@/lib/system-service"
import { inQuietHours, useDisplayPrefs } from "@/lib/display-prefs"
import { onWallWake } from "@/lib/wall-wake"
import { Moon } from "lucide-react"
import { useStore } from "@/lib/store"
import { eventTimeLabel, expandEventsOn, toISODate } from "@/lib/data"

/** How long a tap keeps the wall awake during quiet hours; each touch restarts it. */
const WAKE_MS = 2 * 60_000

const clockText = (hhmm: string, clock24: boolean) => {
  const [h, m] = hhmm.split(":").map(Number)
  const d = new Date(2000, 0, 1, h, m)
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: !clock24 })
}

/**
 * Quiet hours: between the times set in Settings › Display the wall goes dark,
 * either a dim clock or the screen off, so a 3 AM feed in the kitchen isn't
 * lit by the calendar. A tap wakes it for a couple of minutes of normal use.
 */
export function QuietHours() {
  const { events } = useStore()
  const prefs = useDisplayPrefs()
  const q = prefs.quiet
  const [now, setNow] = useState(() => Date.now())
  const [awakeUntil, setAwakeUntil] = useState(0)
  const brightnessBefore = useRef<number | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(id)
  }, [])

  const quiet = inQuietHours(q, new Date(now))
  const asleep = quiet && now >= awakeUntil

  // A family phone walking up wakes it like a tap does.
  useEffect(
    () =>
      onWallWake(() => {
        setAwakeUntil(Date.now() + WAKE_MS)
        setNow(Date.now())
      }),
    [],
  )

  // While awake during quiet hours, any touch keeps it awake a little longer.
  useEffect(() => {
    if (!quiet || asleep) return
    const keepAwake = () => setAwakeUntil(Date.now() + WAKE_MS)
    window.addEventListener("pointerdown", keepAwake)
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, awakeUntil - Date.now()) + 50)
    return () => {
      window.removeEventListener("pointerdown", keepAwake)
      clearTimeout(t)
    }
  }, [quiet, asleep, awakeUntil])

  // Lower the panel itself while asleep, and put it back after.
  useEffect(() => {
    if (!asleep) return
    let cancelled = false
    void getBrightness().then((level) => {
      if (cancelled) return
      brightnessBefore.current = level
      void setBrightness(q.style === "off" ? 5 : 12)
      if (q.style === "off") void sleepDisplay()
    })
    return () => {
      cancelled = true
      if (brightnessBefore.current != null) void setBrightness(brightnessBefore.current)
      brightnessBefore.current = null
    }
  }, [asleep, q.style])

  if (!asleep) return null

  const wake = () => {
    setAwakeUntil(Date.now() + WAKE_MS)
    setNow(Date.now())
  }
  const time = new Date(now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: !prefs.clock24 })
  // The first thing on tomorrow, so a glance at night answers "what's the morning?"
  const tomorrow = new Date(now)
  if (tomorrow.getHours() >= 12) tomorrow.setDate(tomorrow.getDate() + 1)
  const tIso = toISODate(tomorrow)
  const first = expandEventsOn(events, tIso)[0]

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Quiet hours. Tap to wake the display."
      onPointerDown={wake}
      onKeyDown={wake}
      className="fixed inset-0 z-[9990] flex cursor-pointer flex-col items-start justify-end bg-black px-20 pb-20 text-white"
    >
      {q.style === "dim" ? (
        // Set left and low like the system screens; one dim clock, nothing bright.
        <div className="flex flex-col items-start opacity-40">
          <p className="os-label flex items-center gap-2 !text-white">
            <Moon className="size-3.5" /> Quiet until {clockText(q.until, prefs.clock24)}
          </p>
          <p className="mt-4 font-display text-[11rem] leading-[0.85] tabular">{time}</p>
          {first ? (
            <p className="mt-5 font-display text-3xl">
              {tomorrow.getDate() === new Date(now).getDate() ? "This morning" : "Tomorrow"}: {first.title}
              {first.allDay ? "" : ` at ${eventTimeLabel(first, tIso)}`}.
            </p>
          ) : null}
          <p className="mt-6 text-sm">Tap anywhere to wake. Walking up with a phone wakes it too.</p>
        </div>
      ) : null}
    </div>
  )
}

"use client"

import { useEffect, useRef, useState } from "react"
import { getBrightness, setBrightness, sleepDisplay } from "@/lib/system-service"
import { inQuietHours, useDisplayPrefs } from "@/lib/display-prefs"
import { onWallWake } from "@/lib/wall-wake"

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

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Quiet hours. Tap to wake the display."
      onPointerDown={wake}
      onKeyDown={wake}
      className="fixed inset-0 z-[9990] flex cursor-pointer flex-col items-center justify-center bg-black text-white"
    >
      {q.style === "dim" ? (
        <div className="flex flex-col items-center gap-3 opacity-30">
          <p className="font-display text-8xl leading-none tabular">{time}</p>
          <p className="text-sm">Quiet until {clockText(q.until, prefs.clock24)} · tap to wake</p>
        </div>
      ) : null}
    </div>
  )
}

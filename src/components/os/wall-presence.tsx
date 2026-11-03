"use client"

import { useEffect, useRef, useState } from "react"
import { Check, X } from "lucide-react"
import { useAuthenticatedSrc } from "@/hooks/use-authenticated-src"
import { setAsleep, useOsUi } from "./control-center"
import { useKiosk } from "@/lib/kiosk-provider"
import { useStore } from "@/lib/store"
import { liveSocket, type WallEvent, type WallMember } from "@/lib/local-api"
import { memberColorCss } from "@/lib/data"
import { wakeDisplay } from "@/lib/system-service"
import { wakeWall } from "@/lib/wall-wake"
import { addLog } from "@/lib/hub"
import { cn } from "@/lib/utils"

/** How long the "Hi, Leo" greeting stays up. */
const GREET_MS = 4_000
/** A thrown photo or list goes away on its own after this, unless someone closes it first. */
const THROWN_MS = { photo: 45_000, list: 120_000 }

type Thrown = Extract<WallEvent, { type: "throw" }>

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * The wall noticing who's standing at it. Broadcasts this display's Bluetooth
 * beacon (src-tauri/src/beacon.rs) and listens to the hub for phones that
 * heard it up close: a phone walking up wakes the wall from quiet hours, the
 * slideshow or sleep and gets a greeting, and a photo or list pinched on that
 * phone lands here full screen.
 */
export function WallPresence() {
  const { state } = useKiosk()
  const { asleep } = useOsUi()
  const deviceId = state.deviceId
  const householdId = state.householdId
  const [greeting, setGreeting] = useState<WallMember | null>(null)
  const [thrown, setThrown] = useState<Thrown | null>(null)
  const asleepRef = useRef(asleep)
  asleepRef.current = asleep

  // Beacon: on while this app runs; failures (no adapter, the dev VM) are only logged.
  useEffect(() => {
    if (!deviceId || !isTauri()) return
    let cancelled = false
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      if (cancelled) return
      invoke("wall_beacon_start", { deviceId }).catch((e: unknown) =>
        addLog("warning", "system", `Wall beacon off: ${String(e)}`),
      )
    })
    return () => {
      cancelled = true
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("wall_beacon_stop").catch(() => {}))
    }
  }, [deviceId])

  // Wall events only come over the hub's own socket.
  useEffect(() => {
    if (householdId) liveSocket.connect(householdId)
  }, [householdId])

  useEffect(() => {
    if (!deviceId) return
    return liveSocket.subscribeWall((e) => {
      if (!e.deviceIds.includes(deviceId)) return
      wakeWall()
      if (asleepRef.current) {
        setAsleep(false)
        void wakeDisplay()
      }
      if (e.type === "approach") setGreeting(e.member)
      else setThrown(e)
    })
  }, [deviceId])

  useEffect(() => {
    if (!greeting) return
    const t = setTimeout(() => setGreeting(null), GREET_MS)
    return () => clearTimeout(t)
  }, [greeting])

  useEffect(() => {
    if (!thrown) return
    const t = setTimeout(() => setThrown(null), THROWN_MS[thrown.kind])
    return () => clearTimeout(t)
  }, [thrown])

  return (
    <>
      {greeting && !thrown ? (
        <div className="pointer-events-none fixed inset-x-0 top-14 z-[9995] flex justify-center">
          <div className="rise-in flex items-center gap-3 rounded-full bg-card px-5 py-3 shadow-lg ring-1 ring-border">
            <span className="size-3 rounded-full" style={{ background: memberColorCss(greeting.color) }} />
            <span className="text-lg font-medium">Hi, {greeting.name}</span>
          </div>
        </div>
      ) : null}
      {thrown ? <ThrownOverlay thrown={thrown} onClose={() => setThrown(null)} /> : null}
    </>
  )
}

/** What was thrown, full screen, flying in from below like it left the phone. */
function ThrownOverlay({ thrown, onClose }: { thrown: Thrown; onClose: () => void }) {
  const { photos, lists, toggleItem } = useStore()
  const photo = thrown.kind === "photo" ? photos.find((p) => p.id === thrown.id) : undefined
  const list = thrown.kind === "list" ? lists.find((l) => l.id === thrown.id) : undefined

  // Not in this wall's copy (yet): nothing sensible to show.
  if (!photo && !list) return null

  return (
    <div className="fixed inset-0 z-[9996] flex flex-col bg-black/90 text-white" onPointerDown={photo ? onClose : undefined}>
      <div className="flex items-center justify-between px-8 pt-6">
        <div className="flex items-center gap-3 text-lg">
          <span className="size-3 rounded-full" style={{ background: memberColorCss(thrown.from.color) }} />
          From {thrown.from.name}
        </div>
        <button
          type="button"
          aria-label="Close"
          onPointerDown={(e) => { e.stopPropagation(); onClose() }}
          className="flex size-12 items-center justify-center rounded-full bg-white/10"
        >
          <X className="size-6" />
        </button>
      </div>
      <div className="wall-throw-in flex min-h-0 flex-1 items-center justify-center p-8">
        {photo ? <ThrownPhoto src={photo.src} caption={photo.caption} /> : null}
        {list ? (
          <div className="flex max-h-full w-full max-w-2xl flex-col rounded-3xl bg-card p-8 text-card-foreground">
            <h2 className="mb-4 font-display text-4xl">{list.title}</h2>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {list.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => toggleItem(list.id, item.id)}
                    className="flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left text-2xl active:bg-secondary"
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full border-2",
                        item.done ? "border-transparent bg-primary text-primary-foreground" : "border-border",
                      )}
                    >
                      {item.done ? <Check className="size-5" /> : null}
                    </span>
                    <span className={cn(item.done && "text-muted-foreground line-through")}>{item.label}</span>
                  </button>
                </li>
              ))}
              {list.items.length === 0 ? <li className="py-6 text-xl text-muted-foreground">Nothing on this list yet.</li> : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ThrownPhoto({ src, caption }: { src: string; caption: string }) {
  const blob = useAuthenticatedSrc(src)
  return (
    <figure className="flex max-h-full flex-col items-center gap-4">
      {blob ? <img src={blob} alt={caption || "Family photo"} className="max-h-[78vh] max-w-full rounded-2xl object-contain" /> : null}
      {caption ? <figcaption className="text-xl text-white/80">{caption}</figcaption> : null}
    </figure>
  )
}

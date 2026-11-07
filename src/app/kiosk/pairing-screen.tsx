"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { RefreshCw } from "lucide-react"
import { useKiosk } from "@/lib/kiosk-provider"
import { buildPairingPayload } from "@/lib/kiosk-session"
import { SystemHeading, SystemScreen } from "@/components/os/system-screen"
import { LOCAL_API_BASE } from "@/lib/local-api"

/**
 * Full-screen pairing experience shown on the wall display while the kiosk
 * is unclaimed. A household member visits the Solora web app on the same
 * network and enters the display code (or scans the QR) to add this screen.
 *
 * The pairing code is issued by the local solora-server after device
 * registration. Once a member claims it, the polling loop in kiosk-provider
 * detects the change and advances to the "ready" phase automatically.
 */
export function PairingScreen() {
  const { state, loading, refresh } = useKiosk()
  const [qrDataUrl, setQrDataUrl]   = useState<string | null>(null)
  const [qrError, setQrError]       = useState(false)

  // Render QR whenever the pairing code changes.
  useEffect(() => {
    if (!state.pairingCode) {
      setQrDataUrl(null)
      setQrError(false)
      return
    }
    setQrError(false)
    // A phone can only reach the hub at a LAN address, never at loopback.
    const hub = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(LOCAL_API_BASE) ? undefined : `${LOCAL_API_BASE}/api/v1`
    const payload = buildPairingPayload(state.pairingCode, hub)
    QRCode.toDataURL(payload, {
      width: 480,
      margin: 1,
      color: { dark: "#1f2421", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((url) => { setQrDataUrl(url); setQrError(false) })
      .catch(() => setQrError(true))
  }, [state.pairingCode])

  // Derive the LAN address the companion app / admin UI should visit.
  // Strip the localhost fallback so it reads as a real hostname if set.
  const serverOrigin = LOCAL_API_BASE.replace("localhost", window.location.hostname)

  const corners = ["left-0 top-0 border-l-2 border-t-2", "right-0 top-0 border-r-2 border-t-2", "left-0 bottom-0 border-l-2 border-b-2", "right-0 bottom-0 border-r-2 border-b-2"]

  return (
    <SystemScreen
      footerRight={<span className="font-mono normal-case tracking-normal">{serverOrigin}</span>}
      className="grid items-center gap-12 overflow-y-auto px-10 py-10 lg:landscape:grid-cols-[1.2fr_1fr] lg:landscape:gap-20"
    >
      <div className="flex flex-col gap-12">
        <SystemHeading eyebrow="Add this screen" title="Pair this display.">
          <p>This hub already has a family. A parent adds this screen from their phone with the display code.</p>
        </SystemHeading>

        <ol className="grid max-w-xl gap-6">
          {[
            "On your phone, open Solora and sign in to the family.",
            "Go to Settings › Hub & wall display › Displays › Pair a display.",
            "Scan this code, or type the display code under it.",
          ].map((text, i) => (
            <li key={i} className="flex items-center gap-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold tabular">{i + 1}</span>
              <span className="text-lg">{text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col items-center gap-8 lg:landscape:items-end">
        {/* QR in a viewfinder — crop marks instead of a card */}
        <div className="relative p-6">
          {corners.map((c) => (
            <span key={c} aria-hidden className={`absolute size-7 border-foreground ${c}`} />
          ))}
          {qrError ? (
            <div className="flex size-[19rem] flex-col items-start justify-end gap-4 p-2">
              <p className="text-sm text-muted-foreground">Couldn&apos;t draw the code.</p>
              <button type="button" onClick={() => void refresh()} className="os-button">
                <RefreshCw className="size-4" />
                Retry
              </button>
            </div>
          ) : loading || !qrDataUrl ? (
            <div className="flex size-[19rem] flex-col justify-end gap-4 p-2">
              <p className="os-label">{!loading && !state.pairingCode ? "Waiting for a display code" : "Preparing"}</p>
              <div className="boot-line h-[2px] bg-hairline" />
            </div>
          ) : (
            <img src={qrDataUrl} alt="Display code for pairing this screen" className="size-[19rem] rounded-[20px] bg-white p-3" />
          )}
        </div>

        <div className="flex flex-col items-center gap-3 lg:landscape:items-end">
          <p className="os-label">Display code</p>
          {/* One soft box per character, so it reads across the room and types without mistakes. */}
          <div className="flex items-center gap-2">
            {(state.pairingCode ?? "······").split("").map((ch, i) => (
              <span key={i} className="flex items-center gap-2">
                {i === 3 ? <span aria-hidden className="h-0.5 w-3 rounded-full bg-border" /> : null}
                <span className="flex h-[4.5rem] w-14 items-center justify-center rounded-[16px] border border-hairline bg-card font-mono text-[2.2rem] font-medium tabular">
                  {ch}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </SystemScreen>
  )
}

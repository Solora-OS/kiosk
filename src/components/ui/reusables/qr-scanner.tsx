"use client"

import { useEffect, useRef, useState } from "react"
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser"
import { CameraOff } from "lucide-react"

/**
 * Live camera QR scanner. Calls onResult with the decoded text once.
 * Falls back to an error state when no camera is available (e.g. preview),
 * where the parent should offer manual code entry.
 */
export function QrScanner({ onResult, active }: { onResult: (text: string) => void; active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const handledRef = useRef(false)

  useEffect(() => {
    if (!active) return
    handledRef.current = false
    let controls: IScannerControls | null = null
    const reader = new BrowserQRCodeReader()

    reader
      .decodeFromVideoDevice(undefined, videoRef.current ?? undefined, (result) => {
        if (result && !handledRef.current) {
          handledRef.current = true
          onResult(result.getText())
          controls?.stop()
        }
      })
      .then((c) => {
        controls = c
      })
      .catch(() => {
        setError("Camera unavailable. Enter the code manually below.")
      })

    return () => {
      controls?.stop()
    }
  }, [active, onResult])

  if (error) {
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-md bg-secondary text-center text-sm text-muted-foreground">
        <CameraOff className="size-6" />
        <p className="px-6 text-pretty">{error}</p>
      </div>
    )
  }

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-md bg-black">
      <video ref={videoRef} className="size-full object-cover" muted playsInline />
      <div className="pointer-events-none absolute inset-8 rounded-md border-2 border-white/80" />
    </div>
  )
}

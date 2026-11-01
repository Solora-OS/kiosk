"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { cn } from "@/lib/utils"

/**
 * Renders a QR code that always fits its container.
 *
 * The image is generated at 4× the logical `size` for sharp rendering on
 * high-DPI displays, but the container is capped by `max-w-full` so it never
 * overflows a narrow sheet or panel.  Longer payloads (which produce denser
 * modules) are automatically handled at the same visual size — the QR library
 * picks the minimum version required.
 */
export function QrCode({ value, size = 220, className }: { value: string; size?: number; className?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // Generate at 4× for Retina / high-DPI; let the CSS constrain display size.
    QRCode.toDataURL(value, {
      width: size * 4,
      margin: 2,
      // "L" gives fewer modules for the same data → larger, easier-to-scan cells.
      errorCorrectionLevel: "L",
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then((url) => {
        if (active) setDataUrl(url)
      })
      .catch(() => {
        if (active) setDataUrl(null)
      })
    return () => {
      active = false
    }
  }, [value, size])

  return (
    <div
      className={cn("flex items-center justify-center rounded-md bg-white p-3", className)}
      // Fixed logical size, but never wider than the available container.
      style={{ width: size + 24, height: size + 24, maxWidth: "100%", maxHeight: "100%" }}
    >
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="Invite QR code"
          // Let the image fill the padded area rather than overflow.
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <div className="size-full animate-pulse rounded-lg bg-secondary" />
      )}
    </div>
  )
}

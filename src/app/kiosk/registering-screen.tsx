"use client"

import { RefreshCw } from "lucide-react"
import { SystemHeading, SystemScreen } from "@/components/os/system-screen"

/**
 * "Connecting to hub server…" screen — shown while kiosk-provider registers
 * the device with the local solora-server after the setup wizard completes.
 * If the server is unreachable it flips to a retry state.
 */
export function RegisteringScreen({
  error,
  onRetry,
}: {
  error: string | null
  onRetry: () => void
}) {
  return (
    <SystemScreen footerRight={error ? "Hub server unreachable" : "Connecting"} className="justify-end px-10 pb-16">
      {error ? (
        <div className="flex flex-col gap-10">
          <SystemHeading eyebrow="Hub server" title={<>Can&apos;t reach the hub&nbsp;server.</>}>
            <p>{error}</p>
          </SystemHeading>
          <div className="max-w-xl rounded-md border border-border bg-card px-5 py-4">
            <p className="os-label mb-2">On the hub, run</p>
            <code className="font-mono text-sm">systemctl --user start solora-server</code>
          </div>
          <div>
            <button type="button" onClick={onRetry} className="os-button">
              <RefreshCw className="size-4" />
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          <SystemHeading eyebrow="One moment" title="Finding your hub server." />
          <div className="boot-line h-[2px] w-full max-w-md bg-hairline" />
        </div>
      )}
    </SystemScreen>
  )
}

"use client"

import { useCallback, useEffect, useState } from "react"
import { Wifi, WifiLow, WifiHigh, Lock, Check, RefreshCw, ChevronRight } from "lucide-react"
import { WaveLoader } from "@/components/os/loading"
import {
  scanNetworks,
  connect as wifiConnect,
  needsPassword,
  type WifiNetwork,
} from "@/lib/wifi-service"

/** Pick a signal icon by strength so the list reads at a glance. */
function SignalIcon({ signal }: { signal: number }) {
  if (signal >= 66) return <WifiHigh className="size-5" />
  if (signal >= 33) return <Wifi className="size-5" />
  return <WifiLow className="size-5" />
}

/**
 * WiFi setup step. Fully custom UI — the user never sees Ubuntu's network
 * settings. Talks to the WiFi service abstraction, which delegates to
 * NetworkManager via Tauri — only real scan results are shown.
 */
export function WifiStep({
  connectedSsid,
  onConnected,
  onSkip,
}: {
  connectedSsid: string | null
  onConnected: (ssid: string) => void
  onSkip: () => void
}) {
  const [networks, setNetworks] = useState<WifiNetwork[]>([])
  const [scanning, setScanning] = useState(true)
  const [selected, setSelected] = useState<WifiNetwork | null>(null)
  const [password, setPassword] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runScan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const nets = await scanNetworks()
      setNetworks(nets)
    } catch (err) {
      setNetworks([])
      setError(err instanceof Error ? err.message : "Couldn't scan for networks.")
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void runScan()
  }, [runScan])

  const handleSelect = (net: WifiNetwork) => {
    setSelected(net)
    setPassword("")
    setError(null)
    // Open networks connect immediately.
    if (!needsPassword(net.security)) {
      void doConnect(net, undefined)
    }
  }

  const doConnect = async (net: WifiNetwork, pwd?: string) => {
    setConnecting(true)
    setError(null)
    try {
      const ok = await wifiConnect(net.ssid, pwd)
      if (ok) {
        onConnected(net.ssid)
        setSelected(null)
      } else {
        setError("Couldn't connect. Check the password and try again.")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect to this network.")
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="flex max-w-3xl flex-col">
      <div className="mb-4 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="os-label mb-2">{connectedSsid ? "Connected" : "Status"}</p>
          <p className="font-display text-4xl leading-none">{connectedSsid ?? "Not connected"}</p>
        </div>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={scanning}
          className="os-button-quiet !min-h-11"
        >
          <RefreshCw className={`size-4 ${scanning ? "animate-spin" : ""}`} />
          {scanning ? "Scanning" : "Rescan"}
        </button>
      </div>

      {scanning && networks.length === 0 ? (
        <div className="flex flex-col gap-4 py-10">
          <p className="os-label">Listening for networks</p>
          <div className="boot-line h-[2px] max-w-sm bg-hairline" />
        </div>
      ) : networks.length === 0 ? (
        <p className={`py-10 text-pretty ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error ?? "No networks in range. Move the hub closer to your router, then rescan."}
        </p>
      ) : (
        <ul>
          {networks.map((net) => {
            const isConnected = net.ssid === connectedSsid
            const isOpen = selected?.ssid === net.ssid && needsPassword(net.security)
            return (
              <li key={net.ssid} className="border-b border-hairline">
                <button
                  type="button"
                  onClick={() => handleSelect(net)}
                  aria-pressed={isConnected}
                  className="flex w-full items-center gap-5 py-5 text-left"
                >
                  <span className="text-muted-foreground" style={{ opacity: 0.4 + net.signal / 160 }}>
                    <SignalIcon signal={net.signal} />
                  </span>
                  <span className="flex-1 truncate text-xl font-medium">{net.ssid}</span>
                  <span className="os-label tabular">{net.signal}%</span>
                  {needsPassword(net.security) ? <Lock className="size-4 text-muted-foreground" /> : <span className="w-4" />}
                  {isConnected ? <Check className="size-5 text-season" /> : <ChevronRight className="size-5 text-muted-foreground" />}
                </button>

                {/* Inline password row — no modal, the keyboard stays near the field */}
                {isOpen ? (
                  <div className="rise-in flex flex-col gap-4 pb-6 pl-10">
                    <input
                      autoFocus
                      type="password"
                      inputMode="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && password) void doConnect(net, password)
                      }}
                      placeholder={`Password for ${net.ssid}`}
                      className="os-field"
                    />
                    {error ? <p className="text-sm text-destructive">{error}</p> : null}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void doConnect(net, password)}
                        disabled={connecting || !password}
                        className="os-button"
                      >
                        {connecting ? <WaveLoader size={16} /> : null}
                        {connecting ? "Joining" : "Join network"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(null)
                          setError(null)
                        }}
                        disabled={connecting}
                        className="os-button-quiet"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={onSkip}
        className="mt-8 self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Set up Wi‑Fi later
      </button>

      {/* Joining an open network */}
      {selected && !needsPassword(selected.security) && connecting ? (
        <p className="os-label mt-6">Joining {selected.ssid}…</p>
      ) : null}
    </div>
  )
}

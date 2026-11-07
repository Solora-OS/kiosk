import { useStore } from "@/lib/store"
import { Wifi, Activity, Battery, Clock } from "lucide-react"
import { cn } from "@/lib/utils"

export function KioskStatusWidget() {
  const { kioskDevices } = useStore()
  const kiosk = kioskDevices[0]

  if (!kiosk) {
    return (
      <div className="space-y-2 rounded-[20px] border border-amber-500/30 bg-amber-500/10 p-4">
        <p className="text-sm font-medium text-amber-700">No kiosk device registered</p>
        <p className="text-xs text-amber-600/80">
          The kiosk app needs to sign in and register with this household to appear here. 
          Make sure the kiosk is running with the same admin account.
        </p>
        <div className="flex gap-2 pt-2">
          <div className="text-xs text-amber-600/80">
            <p className="font-medium">Kiosk setup:</p>
            <ol className="list-inside list-decimal space-y-1 pt-1">
              <li>Run kiosk with admin credentials</li>
              <li>Sign in to this household</li>
              <li>Check browser console for [v0] debug logs</li>
            </ol>
          </div>
        </div>
      </div>
    )
  }

  const lastSeen = new Date(kiosk.last_heartbeat)
  const timeSinceUpdate = Math.round((Date.now() - lastSeen.getTime()) / 1000)
  const isRecent = timeSinceUpdate < 60 // Within 60 seconds

  return (
    <div className="space-y-3 rounded-[20px] border border-border/50 bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{kiosk.device_name}</h3>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
            kiosk.is_online
              ? "bg-green-500/10 text-green-700"
              : "bg-red-500/10 text-red-700"
          )}
        >
          <div
            className={cn(
              "size-2 rounded-full",
              kiosk.is_online ? "bg-green-500" : "bg-red-500"
            )}
          />
          {kiosk.is_online ? "Online" : "Offline"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* WiFi Signal */}
        <div className="flex items-center gap-2 rounded-[14px] bg-muted/50 p-2">
          <Wifi className="size-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">WiFi</p>
            <p className="text-sm font-semibold">{kiosk.wifi_signal} dBm</p>
          </div>
        </div>

        {/* Ping Latency */}
        <div className="flex items-center gap-2 rounded-[14px] bg-muted/50 p-2">
          <Activity className="size-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Ping</p>
            <p className="text-sm font-semibold">{kiosk.ping_latency_ms}ms</p>
          </div>
        </div>

        {/* Battery */}
        {kiosk.battery_percent !== null && kiosk.battery_percent !== undefined && (
          <div className="flex items-center gap-2 rounded-[14px] bg-muted/50 p-2">
            <Battery className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Battery</p>
              <p className="text-sm font-semibold">{kiosk.battery_percent}%</p>
            </div>
          </div>
        )}

        {/* Last Update */}
        <div className="flex items-center gap-2 rounded-[14px] bg-muted/50 p-2">
          <Clock className="size-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Last seen</p>
            <p className="text-sm font-semibold">
              {isRecent ? `${timeSinceUpdate}s ago` : lastSeen.toLocaleTimeString()}
            </p>
          </div>
        </div>
      </div>

      {/* Device Info */}
      {kiosk.device_info && (
        <div className="border-t border-border/30 pt-2">
          <p className="text-xs text-muted-foreground">
            {JSON.parse(kiosk.device_info).platform}
          </p>
        </div>
      )}
    </div>
  )
}

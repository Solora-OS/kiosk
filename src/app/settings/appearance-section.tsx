"use client"

import { useEffect, useRef, useState } from "react"
import { Download, Upload } from "lucide-react"
import { kioskToast } from "@/components/os/kiosk-toast"
import { cn } from "@/lib/utils"
import { useTheme, type Theme } from "@/components/theme-provider"
import { useSeason } from "@/components/season-provider"
import { HolidayPicker } from "@/components/ui/reusables/holiday-picker"
import { SeasonPicker } from "@/components/ui/reusables/season-picker"
import { useStore } from "@/lib/store"
import { parseSeasonFile, SEASON_TEMPLATE } from "@/lib/seasons"
import { Fader, Segmented, Switch, useThrottled } from "@/components/os/controls"
import { getAudio, getBrightness, setBrightness, setVolume } from "@/lib/system-service"
import { openControlCenter } from "@/components/os/control-center"

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { setMode, effectsOn, setEffectsOn, importSeason, removeSeason } = useSeason()
  const { can } = useStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [seasonOpen, setSeasonOpen] = useState(false)

  const onFile = async (file: File) => {
    try {
      const season = parseSeasonFile(await file.text())
      const where = await importSeason(season)
      setMode(season.id)
      kioskToast.success(`${season.name} installed`, { description: where === "house" ? "Every phone in the house can pick it now." : "Kept on this display only; the hub couldn't be reached." })
    } catch (err) {
      kioskToast.error("Couldn't import theme", { description: err instanceof Error ? err.message : undefined })
    }
  }

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([SEASON_TEMPLATE], { type: "application/json" }))
    const a = document.createElement("a")
    a.href = url
    a.download = "solora-season.json"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="space-y-6">
      <h2 className="os-label px-1">Appearance</h2>

      <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <p className="text-[0.95rem] font-medium">Light</p>
          <p className="text-sm text-muted-foreground">Paper by day, graphite by night — or follow the clock.</p>
        </div>
        <div className="w-full md:w-80">
          <Segmented<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Paper" },
              { value: "dark", label: "Graphite" },
              { value: "system", label: "Auto" },
            ]}
          />
        </div>
      </div>

      <div className="space-y-4">
        <SeasonPicker
          open={seasonOpen}
          onOpenChange={setSeasonOpen}
          onRemove={(id) => void removeSeason(id).catch(() => {})}
          footer={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-secondary text-sm font-medium"
              >
                <Upload className="size-4" />
                Import theme
              </button>
              <button
                type="button"
                onClick={downloadTemplate}
                className="flex h-10 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Download className="size-4" />
                Template
              </button>
            </div>
          }
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
            e.target.value = ""
          }}
        />
        <HolidayPicker canEdit={can("hub")} />

        <label className="flex items-center justify-between gap-4 border-t border-hairline pt-4">
          <span>
            <span className="block text-[0.95rem] font-medium">Ambient effects</span>
            <span className="block text-sm text-muted-foreground">Snowfall, drifting leaves, embers. Off keeps just the color.</span>
          </span>
          <Switch label="Ambient effects" on={effectsOn} onChange={setEffectsOn} />
        </label>
      </div>
    </section>
  )
}

/** Sound + screen, the same controls as the Control Center but always laid out. */
export function SoundDisplaySection() {
  const [vol, setVol] = useState(50)
  const [bright, setBright] = useState<number | null>(null)
  useEffect(() => {
    void getAudio().then((a) => setVol(a.volume))
    void getBrightness().then(setBright)
  }, [])
  const pushVol = useThrottled(setVolume)
  const pushBright = useThrottled(setBrightness)

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between px-1">
        <h2 className="os-label">Sound &amp; display</h2>
        <button type="button" onClick={openControlCenter} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Open Control Center
        </button>
      </div>
      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[0.95rem] font-medium">Volume</span>
            <span className="font-mono text-sm tabular text-muted-foreground">{vol}</span>
          </div>
          <Fader label="Volume" value={vol} onChange={(v) => { setVol(v); pushVol(v) }} />
        </div>
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[0.95rem] font-medium">Brightness</span>
            <span className="font-mono text-sm tabular text-muted-foreground">{bright ?? "Monitor"}</span>
          </div>
          <Fader
            label="Brightness"
            min={5}
            value={bright ?? 0}
            disabled={bright === null}
            onChange={(v) => { setBright(v); pushBright(v) }}
          />
        </div>
      </div>
    </section>
  )
}

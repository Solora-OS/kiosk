"use client"

import type { ReactNode } from "react"
import { LayoutGrid } from "lucide-react"
import { Segmented, Switch } from "@/components/os/controls"
import { setDisplayPrefs, useDisplayPrefs, type TextSize } from "@/lib/display-prefs"
import { useStore, type TabKey } from "@/lib/store"

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
      <div>
        <p className="text-[0.95rem] font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <div className="w-full md:w-96">{children}</div>
    </div>
  )
}

/** Settings › Display: how this display reads and feels. */
export function InterfaceSection() {
  const prefs = useDisplayPrefs()
  return (
    <section className="space-y-6">
      <h2 className="os-label px-1">Interface</h2>
      <Row title="Text size" hint="Bigger text reads better across the kitchen.">
        <Segmented<TextSize>
          value={prefs.textSize}
          onChange={(textSize) => setDisplayPrefs({ textSize })}
          options={[
            { value: "s", label: "Small" },
            { value: "m", label: "Default" },
            { value: "l", label: "Large" },
            { value: "xl", label: "Huge" },
          ]}
        />
      </Row>
      <Row title="Clock" hint="On the status bar and the clock widget.">
        <Segmented<"12" | "24">
          value={prefs.clock24 ? "24" : "12"}
          onChange={(v) => setDisplayPrefs({ clock24: v === "24" })}
          options={[
            { value: "12", label: "5:30 PM" },
            { value: "24", label: "17:30" },
          ]}
        />
      </Row>
      <div className="flex items-center justify-between gap-6">
        <div>
          <p className="text-[0.95rem] font-medium">Celebrations</p>
          <p className="text-sm text-muted-foreground">Confetti when chores or a list are all done.</p>
        </div>
        <Switch label="Celebrations" on={prefs.celebrations} onChange={(celebrations) => setDisplayPrefs({ celebrations })} />
      </div>
      <div className="space-y-4 rounded-lg bg-card p-4">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="text-[0.95rem] font-medium">Quiet hours</p>
            <p className="text-sm text-muted-foreground">Dark at night, for late feeds and early mornings. A tap wakes it for a couple of minutes.</p>
          </div>
          <Switch label="Quiet hours" on={prefs.quiet.on} onChange={(on) => setDisplayPrefs({ quiet: { ...prefs.quiet, on } })} />
        </div>
        {prefs.quiet.on ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-muted-foreground">
                From
                <input id="quiet-from" type="time" value={prefs.quiet.from}
                  onChange={(e) => e.target.value && setDisplayPrefs({ quiet: { ...prefs.quiet, from: e.target.value } })}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2.5 text-[0.95rem] text-foreground" />
              </label>
              <label className="text-sm text-muted-foreground">
                Until
                <input id="quiet-until" type="time" value={prefs.quiet.until}
                  onChange={(e) => e.target.value && setDisplayPrefs({ quiet: { ...prefs.quiet, until: e.target.value } })}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2.5 text-[0.95rem] text-foreground" />
              </label>
            </div>
            <Segmented<"dim" | "off">
              value={prefs.quiet.style}
              onChange={(style) => setDisplayPrefs({ quiet: { ...prefs.quiet, style } })}
              options={[
                { value: "dim", label: "Dim clock" },
                { value: "off", label: "Screen off" },
              ]}
            />
          </>
        ) : null}
      </div>
    </section>
  )
}

const TAB_CHOICES: { value: TabKey; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "calendar", label: "Calendar" },
  { value: "chores", label: "Chores" },
  { value: "photos", label: "Photos" },
]
const HIDEABLE: { key: TabKey; label: string }[] = [
  { key: "calendar", label: "Calendar" },
  { key: "chores", label: "Chores" },
  { key: "rewards", label: "Rewards" },
  { key: "lists", label: "Lists" },
  { key: "meals", label: "Meals" },
  { key: "photos", label: "Photos" },
]

/** Settings › Display: the home screen, where the wall starts, and which tabs show. */
export function HomeScreenSection() {
  const prefs = useDisplayPrefs()
  const { setTab } = useStore()
  const returnValue = prefs.returnAfterMins === null ? "never" : String(prefs.returnAfterMins)
  return (
    <section className="space-y-6">
      <h2 className="os-label px-1">Home screen</h2>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-card p-4">
        <div>
          <p className="text-[0.95rem] font-medium">Widgets</p>
          <p className="text-sm text-muted-foreground">Add, move, resize and set up widgets right on the home screen.</p>
        </div>
        <button type="button" onClick={() => setTab("home")} className="os-button">
          <LayoutGrid className="size-4" /> Go to Home
        </button>
      </div>
      <Row title="Start screen" hint="Where this display opens, and comes back to.">
        <Segmented<TabKey> value={prefs.startTab} onChange={(startTab) => setDisplayPrefs({ startTab })} options={TAB_CHOICES} />
      </Row>
      <Row title="Come back to it" hint="After nobody has touched the screen for a while.">
        <Segmented<string>
          value={returnValue}
          onChange={(v) => setDisplayPrefs({ returnAfterMins: v === "never" ? null : Number(v) })}
          options={[
            { value: "1", label: "1 min" },
            { value: "3", label: "3 min" },
            { value: "10", label: "10 min" },
            { value: "never", label: "Never" },
          ]}
        />
      </Row>
      <div className="space-y-3">
        <div>
          <p className="text-[0.95rem] font-medium">Tabs in the side menu</p>
          <p className="text-sm text-muted-foreground">Hide the ones your family doesn&apos;t use. Home and Settings always stay.</p>
        </div>
        <div className="divide-y divide-hairline rounded-lg bg-card">
          {HIDEABLE.map(({ key, label }) => {
            const shown = !prefs.hiddenTabs.includes(key)
            return (
              <div key={key} className="flex items-center justify-between px-4 py-3">
                <span className="text-[0.95rem]">{label}</span>
                <Switch
                  label={`Show ${label}`}
                  on={shown}
                  onChange={(on) =>
                    setDisplayPrefs({ hiddenTabs: on ? prefs.hiddenTabs.filter((t) => t !== key) : [...prefs.hiddenTabs, key] })
                  }
                />
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

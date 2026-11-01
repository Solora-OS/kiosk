"use client"

import { useState } from "react"
import { ChevronDown, ShieldCheck } from "lucide-react"
import { type MemberRole, type PermissionArea, permissionAreas, permissionDescriptions, permissionLabels } from "@/lib/data"
import { cn } from "@/lib/utils"

/**
 * What a family member can manage, set with one tap for the usual cases and
 * six switches under "Fine-tune" for the rest. Kept identical in mobile/ and
 * kiosk/.
 */

export const PERMISSION_PRESETS: { id: string; label: string; detail: string; areas: PermissionArea[] }[] = [
  { id: "parent", label: "Co-parent", detail: "Everything except hub settings", areas: ["calendar", "chores", "lists", "meals", "members"] },
  { id: "household", label: "Runs the house", detail: "Calendar, chores, lists and meals", areas: ["calendar", "chores", "lists", "meals"] },
  { id: "kitchen", label: "Meals & shopping", detail: "Plans meals and keeps the lists", areas: ["lists", "meals"] },
  { id: "none", label: "Just their own things", detail: "Ticks chores and adds to lists", areas: [] },
]

/** Where a new member starts, by role: adults as co-parents, kids with their own things. */
export function defaultPermissions(role: MemberRole): PermissionArea[] {
  return role === "adult" ? PERMISSION_PRESETS[0].areas : []
}

const sameAreas = (a: PermissionArea[], b: PermissionArea[]) => a.length === b.length && a.every((x) => b.includes(x))

export function PermissionPicker({
  name,
  value,
  onChange,
}: {
  name: string
  value: PermissionArea[]
  onChange: (areas: PermissionArea[]) => void
}) {
  const preset = PERMISSION_PRESETS.find((p) => sameAreas(p.areas, value))
  // Folded by default; a mix no preset covers always shows the switches.
  const [fineTune, setFineTune] = useState(false)
  const open = fineTune || !preset

  const toggle = (area: PermissionArea) =>
    onChange(value.includes(area) ? value.filter((a) => a !== area) : [...value, area])

  return (
    <div className="rounded-md border border-border/70 p-3">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Permissions</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">What can {name.trim() || "this member"} manage?</p>

      <div className="grid grid-cols-2 gap-2">
        {PERMISSION_PRESETS.map((p) => {
          const active = preset?.id === p.id
          return (
            <button key={p.id} type="button" aria-pressed={active} onClick={() => onChange(p.areas)}
              className={cn(
                "rounded-md px-3 py-2 text-left transition-colors",
                active ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
              )}>
              <span className="block text-sm font-semibold leading-tight">{p.label}</span>
              <span className={cn("mt-0.5 block text-[11px] leading-snug", active ? "text-primary-foreground/80" : "text-muted-foreground")}>{p.detail}</span>
            </button>
          )
        })}
      </div>

      <button type="button" onClick={() => setFineTune((v) => !v)} aria-expanded={open}
        className="mt-3 flex items-center gap-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {preset ? "Fine-tune" : "Custom mix"}
      </button>

      {open ? (
        <div className="mt-1 space-y-1">
          {permissionAreas.map((area) => {
            const on = value.includes(area)
            return (
              <div key={area} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{permissionLabels[area]}</span>
                  <span className="block text-xs text-muted-foreground">{permissionDescriptions[area]}</span>
                </span>
                <button type="button" role="switch" aria-checked={on} aria-label={`Can manage ${permissionLabels[area]}`} onClick={() => toggle(area)}
                  className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", on ? "bg-member-green" : "bg-border")}>
                  <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[1.375rem]" : "left-0.5")} />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

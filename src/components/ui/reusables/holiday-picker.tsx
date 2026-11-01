"use client"

import { useState } from "react"
import { useSeason } from "@/components/season-provider"
import { saveHouseholdSeasons } from "@/lib/household-seasons"
import { BUILTIN_SEASONS, HOLIDAYS } from "@/lib/seasons"
import { PickerDialog, PickerOption, PickerRow } from "./season-picker"

/** The look each holiday uses on the wall, for the swatch beside it. */
const LOOK: Record<string, string> = {
  christmas: "christmas", halloween: "halloween", valentines: "valentines", "pink-october": "pink-october",
  ramadan: "ramadan", "eid-al-adha": "eid", easter: "easter", hanukkah: "hanukkah", diwali: "diwali", "lunar-new-year": "lunar-new-year",
}

/**
 * "Holidays we celebrate": which holidays the house dresses up for when the
 * season is on Auto. Saved on the hub, so every phone and the wall follow it.
 * Kept identical in mobile/ and kiosk/.
 */
export function HolidayPicker({ canEdit }: { canEdit: boolean }) {
  const { holidays } = useSeason()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const toggle = async (id: string) => {
    setError(null)
    setSaving(id)
    try {
      await saveHouseholdSeasons({ holidays: holidays.includes(id) ? holidays.filter((h) => h !== id) : [...holidays, id] })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again when the hub is reachable.")
    } finally {
      setSaving(null)
    }
  }

  const chosen = HOLIDAYS.filter((h) => holidays.includes(h.id))
  const summary =
    chosen.length === 0 ? "None" : chosen.length <= 2 ? chosen.map((h) => h.label).join(", ") : `${chosen.length} holidays`

  return (
    <>
      <PickerRow label="Holidays we celebrate" value={summary} onClick={() => setOpen(true)} />
      <PickerDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Holidays we celebrate"
        footer={
          <p className="text-xs text-muted-foreground">
            On Automatic, the house dresses up for these, on every phone and the wall.
            {canEdit ? "" : " A parent can change them."} Ramadan and Eid follow the expected moon sighting.
          </p>
        }
      >
        {HOLIDAYS.map((h) => {
          const look = BUILTIN_SEASONS.find((s) => s.id === LOOK[h.id])
          return (
            <PickerOption
              key={h.id}
              label={h.label}
              detail={h.when}
              swatch={look?.accent.light}
              selected={holidays.includes(h.id)}
              disabled={!canEdit || saving !== null}
              onClick={() => void toggle(h.id)}
            />
          )
        })}
        {error ? <p className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
      </PickerDialog>
    </>
  )
}

"use client"

import { cn } from "@/lib/utils"
import { ChoiceChips, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"

const weekdayLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
// Monday-first, matching the calendar's week strip.
const weekdayPicker = [
  { day: 1, label: "M" }, { day: 2, label: "T" }, { day: 3, label: "W" }, { day: 4, label: "T" },
  { day: 5, label: "F" }, { day: 6, label: "S" }, { day: 0, label: "S" },
]

type Preset = "never" | "daily" | "weekdays" | "weekly" | "custom"

const sameDays = (a: number[], b: number[]) => [...a].sort().join(",") === [...b].sort().join(",")

function presetFor(days: number[], anchorDay: number): Preset {
  if (days.length === 0) return "never"
  if (days.length === 7) return "daily"
  if (sameDays(days, [1, 2, 3, 4, 5])) return "weekdays"
  if (sameDays(days, [anchorDay])) return "weekly"
  return "custom"
}

/**
 * "Repeats" for an event: preset chips, weekday chips for "Pick days", and
 * an optional end date. `days` empty means the event doesn't repeat.
 * `anchorDay` is the weekday of the event's first date (0 = Sunday).
 */
export function RepeatPicker({
  days,
  until,
  anchorDay,
  minUntil,
  onChange,
}: {
  days: number[]
  until: string | null
  anchorDay: number
  /** Earliest allowed end date (the event's first date). */
  minUntil: string
  onChange: (next: { days: number[]; until: string | null }) => void
}) {
  const preset = presetFor(days, anchorDay)

  const choose = (p: Preset) => {
    const next =
      p === "never" ? [] :
      p === "daily" ? [0, 1, 2, 3, 4, 5, 6] :
      p === "weekdays" ? [1, 2, 3, 4, 5] :
      p === "weekly" ? [anchorDay] :
      // "Pick days" starts from the current selection, or the event's own weekday.
      days.length ? days : [anchorDay]
    onChange({ days: next, until: next.length ? until : null })
  }

  const toggleDay = (day: number) => {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day]
    // Unpicking the last day would silently stop the repeat; keep at least one.
    if (next.length) onChange({ days: next, until })
  }

  return (
    <>
      <div>
        <span className="os-label mb-2 block">Repeats</span>
        <ChoiceChips
          value={preset}
          onChange={choose}
          options={[
            { value: "never", label: "Never" },
            { value: "daily", label: "Every day" },
            { value: "weekdays", label: "Weekdays" },
            { value: "weekly", label: `Every ${weekdayLong[anchorDay]}` },
            { value: "custom", label: "Pick days" },
          ]}
        />
      </div>
      {preset === "custom" ? (
        <Field label="On">
          <div className="flex gap-1.5">
            {weekdayPicker.map(({ day, label }) => {
              const on = days.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  aria-pressed={on}
                  aria-label={weekdayLong[day]}
                  className={cn(
                    "size-11 rounded-full text-sm font-semibold transition-colors",
                    on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </Field>
      ) : null}
      {preset !== "never" ? (
        <Field label="Until (optional)">
          <input
            type="date"
            value={until ?? ""}
            min={minUntil}
            onChange={(e) => onChange({ days, until: e.target.value || null })}
            className={inputClass}
          />
        </Field>
      ) : null}
    </>
  )
}

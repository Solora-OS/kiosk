"use client"

/**
 * CalendarImportSheet — shown after connecting a Google/Microsoft provider.
 * Lets the user map each external calendar (Google) or category (Outlook)
 * to a Solora calendar. Unmapped → "General" calendar (auto-created on sync).
 */

import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"
import { WaveLoader, SkeletonRows } from "@/components/os/loading"
import { BottomSheet, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { LOCAL_API_BASE, tokenStore } from "@/lib/local-api"
import type { Calendar, MemberColor } from "@/lib/data"

// Server returns a richer shape than the data.ts Calendar type
type ServerCalendar = { id: string; name: string; color: MemberColor; memberIds: string[] }

type ExternalCalendar = { id: string; name: string; color?: string }
type MappingState = Record<string, string | ""> // externalId → soloraCalendarId | ""

async function apiGet<T>(path: string): Promise<T> {
  const token = tokenStore.get()
  const res = await fetch(`${LOCAL_API_BASE}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<T>
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const token = tokenStore.get()
  const res = await fetch(`${LOCAL_API_BASE}/api/v1${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const token = tokenStore.get()
  const res = await fetch(`${LOCAL_API_BASE}/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<T>
}

export function CalendarImportSheet({
  open,
  provider,
  lumCalendars,
  onClose,
  onMappingSaved,
}: {
  open: boolean
  provider: "google" | "microsoft" | null
  lumCalendars: Calendar[]
  onClose: () => void
  onMappingSaved: (newCalendars: Calendar[]) => void
}) {
  const [externals, setExternals] = useState<ExternalCalendar[]>([])
  const [mappings, setMappings] = useState<MappingState>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newCalName, setNewCalName] = useState("")
  const [creatingFor, setCreatingFor] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !provider) return
    setLoading(true)
    setError(null)
    Promise.all([
      apiGet<ExternalCalendar[]>(`/calendar-providers/${provider}/external-calendars`),
      apiGet<{ externalId: string; calendarId: string | null }[]>("/calendar-providers/mappings"),
    ])
      .then(([exts, existing]) => {
        setExternals(exts)
        const init: MappingState = {}
        for (const ext of exts) {
          const match = existing.find((m) => m.externalId === ext.id)
          init[ext.id] = match?.calendarId ?? ""
        }
        setMappings(init)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load calendars"))
      .finally(() => setLoading(false))
  }, [open, provider])

  const handleCreateCalendar = async (externalId: string) => {
    if (!newCalName.trim()) return
    try {
      const cal = await apiPost<ServerCalendar>("/calendars", { name: newCalName.trim(), color: "blue" })
      setMappings((m) => ({ ...m, [externalId]: cal.id }))
      onMappingSaved([...lumCalendars, { id: cal.id, name: cal.name, color: cal.color, memberIds: cal.memberIds }])
      setCreatingFor(null)
      setNewCalName("")
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create calendar")
    }
  }

  const handleSave = async () => {
    if (!provider) return
    setSaving(true)
    setError(null)
    try {
      const items = externals.map((ext) => ({
        provider,
        externalId: ext.id,
        externalName: ext.name,
        calendarId: mappings[ext.id] || null,
      }))
      await apiPut("/calendar-providers/mappings", items)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save mappings")
    } finally {
      setSaving(false)
    }
  }

  const providerLabel = provider === "google" ? "Google Calendar" : "Outlook"

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`Import from ${providerLabel}`}
      footer={
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {saving ? <WaveLoader size={16} /> : null}
          {saving ? "Saving…" : "Save mapping"}
        </button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Map each {provider === "google" ? "Google calendar" : "Outlook category"} to a Solora calendar.
        Leave blank to import into <span className="font-medium">General</span>.
      </p>

      {loading ? (
        <SkeletonRows rows={4} lead="size-2.5 rounded-full" />
      ) : externals.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No {provider === "google" ? "calendars" : "categories"} found.
        </p>
      ) : (
        <div className="space-y-4">
          {externals.map((ext) => (
            <div key={ext.id} className="space-y-1.5">
              <div className="flex items-center gap-2">
                {ext.color ? (
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: ext.color }} />
                ) : null}
                <span className="text-sm font-medium">{ext.name}</span>
              </div>
              {creatingFor === ext.id ? (
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={newCalName}
                    onChange={(e) => setNewCalName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleCreateCalendar(ext.id) }}
                    placeholder="New calendar name"
                    className={inputClass + " flex-1"}
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateCalendar(ext.id)}
                    className="rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCreatingFor(null); setNewCalName("") }}
                    className="rounded-[14px] border border-border px-3 py-2 text-xs font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <Field label="">
                  <div className="relative">
                    <select
                      value={mappings[ext.id] ?? ""}
                      onChange={(e) => {
                        if (e.target.value === "__new__") { setCreatingFor(ext.id); return }
                        setMappings((m) => ({ ...m, [ext.id]: e.target.value }))
                      }}
                      className={inputClass + " appearance-none pr-8"}
                    >
                      <option value="">General (uncategorized)</option>
                      {lumCalendars.map((cal) => (
                        <option key={cal.id} value={cal.id}>{cal.name}</option>
                      ))}
                      <option value="__new__">+ Create new calendar…</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </Field>
              )}
            </div>
          ))}
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </BottomSheet>
  )
}

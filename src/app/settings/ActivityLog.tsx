"use client"

import { useEffect, useState } from "react"
import { RefreshCw, Trash2, CalendarDays, ChefHat, Users, Link2, Settings2, List } from "lucide-react"
import { SkeletonRows } from "@/components/os/orbit"
import { LOCAL_API_BASE, tokenStore } from "@/lib/local-api"
import { cn } from "@/lib/utils"

type LogEntry = {
  id: string
  actorId: string | null
  actorName: string
  action: string
  resourceType: string
  resourceId: string | null
  resourceName: string
  metadata: Record<string, unknown>
  createdAt: string
}

const ACTION_META: Record<string, { label: string; color: string }> = {
  "event.create":          { label: "Created event",        color: "text-member-teal" },
  "event.update":          { label: "Updated event",        color: "text-member-blue" },
  "event.delete":          { label: "Deleted event",        color: "text-destructive" },
  "chore.create":          { label: "Created chore",        color: "text-member-teal" },
  "chore.delete":          { label: "Deleted chore",        color: "text-destructive" },
  "meal.create":           { label: "Planned meal",         color: "text-member-amber" },
  "meal.update":           { label: "Updated meal",         color: "text-member-blue" },
  "meal.delete":           { label: "Removed meal",         color: "text-destructive" },
  "member.create":         { label: "Added member",         color: "text-member-teal" },
  "member.update":         { label: "Updated member",       color: "text-member-blue" },
  "member.delete":         { label: "Removed member",       color: "text-destructive" },
  "member.invite":         { label: "Sent invite",          color: "text-member-pink" },
  "member.invite_cancel":  { label: "Cancelled invite",     color: "text-muted-foreground" },
  "calendar.create":       { label: "Created calendar",     color: "text-member-teal" },
  "calendar.update":       { label: "Updated calendar",     color: "text-member-blue" },
  "calendar.delete":       { label: "Deleted calendar",     color: "text-destructive" },
  "list.create":           { label: "Created list",         color: "text-member-teal" },
  "list.delete":           { label: "Deleted list",         color: "text-destructive" },
  "provider.connect":      { label: "Connected provider",   color: "text-member-green" },
  "provider.disconnect":   { label: "Disconnected provider", color: "text-destructive" },
  "hub.restart":           { label: "Restarted hub",        color: "text-member-coral" },
  "hub.factory_reset":     { label: "Factory reset",        color: "text-destructive" },
}

function ResourceIcon({ type }: { type: string }) {
  const cls = "size-4"
  if (type === "event" || type === "calendar") return <CalendarDays className={cls} />
  if (type === "meal") return <ChefHat className={cls} />
  if (type === "member") return <Users className={cls} />
  if (type === "calendar_provider") return <Link2 className={cls} />
  if (type === "list") return <List className={cls} />
  return <Settings2 className={cls} />
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

async function apiGet<T>(path: string): Promise<T> {
  const token = tokenStore.get()
  const res = await fetch(`${LOCAL_API_BASE}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<T>
}

export function ActivityLog({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    apiGet<LogEntry[]>("/activity-logs?limit=100")
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div>
        {loading && entries.length === 0 ? (
          <SkeletonRows rows={6} className="rounded-md border border-border px-4" />
        ) : error ? (
          <div className="p-6 text-center text-sm text-destructive">{error}</div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No activity yet.</div>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {entries.map((e) => {
              const meta = ACTION_META[e.action] ?? { label: e.action, color: "text-foreground" }
              return (
                <li key={e.id} className="flex items-start gap-3 px-4 py-3.5">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <ResourceIcon type={e.resourceType} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {e.actorName ? <span className="font-semibold">{e.actorName} </span> : null}
                      <span className={cn("font-medium", meta.color)}>{meta.label}</span>
                      {e.resourceName ? (
                        <span className="text-muted-foreground"> · {e.resourceName}</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{timeAgo(e.createdAt)}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

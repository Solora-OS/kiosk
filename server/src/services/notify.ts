/**
 * notify.ts — notifications the hub sends on its own: event reminders, reward
 * requests and decisions, and family news. Each phone shows the ones meant for
 * its person (or for everyone) and turns new ones into an alert.
 */

import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { broadcast } from "../broadcaster"

type Note = { title: string; body?: string; time?: string; ref?: string }

/** Send `note` to these members, one copy each; null sends one copy to everyone. */
export function notifyMembers(householdId: string, memberIds: string[] | null, note: Note): void {
  const db = getDb()
  const insert = db.prepare(
    "INSERT INTO notifications (id, household_id, member_id, title, body, time, ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  const targets = memberIds === null ? [null] : [...new Set(memberIds)]
  for (const memberId of targets) {
    const id = uuidv4()
    insert.run(id, householdId, memberId, note.title, note.body ?? "", note.time ?? "", note.ref ?? null)
    broadcast(householdId, "notifications:created", {
      id, householdId, memberId: memberId ?? undefined, title: note.title, body: note.body ?? "",
      time: note.time ?? "", ref: note.ref ?? undefined, createdAt: new Date().toISOString(), read: false,
    })
  }
}

/** Members who run chores and rewards: admins and anyone with the Chores permission. */
export function choreManagers(householdId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id, role, permissions FROM members WHERE household_id = ?")
    .all(householdId) as { id: string; role: string; permissions: string | null }[]
  return rows
    .filter((m) => m.role === "admin" || (m.permissions ?? "").includes("\"chores\""))
    .map((m) => m.id)
}

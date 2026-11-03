import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"

const router = Router()
router.use(requireAuth)

export type LogAction =
  | "event.create" | "event.update" | "event.delete"
  | "chore.create" | "chore.update" | "chore.delete"
  | "meal.create" | "meal.update" | "meal.delete"
  | "member.create" | "member.update" | "member.delete" | "member.invite" | "member.invite_cancel"
  | "calendar.create" | "calendar.update" | "calendar.delete"
  | "list.create" | "list.delete"
  | "provider.connect" | "provider.disconnect"
  | "hub.restart" | "hub.factory_reset"
  // Solora's own actions on this hub, recorded by services/solora-support.ts
  | `solora.${string}`
  | "support.granted" | "support.denied" | "support.revoked"
  | "device.reported_lost" | "device.found"

type LogInput = {
  householdId: string
  actorId?: string | null
  actorName?: string
  action: LogAction
  resourceType: string
  resourceId?: string | null
  resourceName?: string
  metadata?: Record<string, unknown>
}

export function writeLog(input: LogInput): void {
  try {
    const db = getDb()
    // Callers pass the signed-in user's id; actor_id points at their member
    // record (or nothing, e.g. for the wall display).
    const actor = input.actorId
      ? (db.prepare("SELECT id, name FROM members WHERE (id = ? OR user_id = ?) AND household_id = ?")
          .get(input.actorId, input.actorId, input.householdId) as { id: string; name: string } | undefined)
      : undefined
    db
      .prepare(
        `INSERT INTO activity_logs
           (id, household_id, actor_id, actor_name, action, resource_type, resource_id, resource_name, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv4(),
        input.householdId,
        actor?.id ?? null,
        input.actorName ?? actor?.name ?? "",
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.resourceName ?? "",
        JSON.stringify(input.metadata ?? {}),
      )
  } catch (err) {
    // Never let logging crash the caller.
    console.error("[activity-log] write failed:", err)
  }
}

// GET /api/v1/activity-logs?limit=50&offset=0
router.get("/", (req: Request, res: Response) => {
  const { householdId } = (req as AuthRequest).user
  const limit = Math.min(Number(req.query.limit ?? 50), 200)
  const offset = Number(req.query.offset ?? 0)

  type Row = {
    id: string
    household_id: string
    actor_id: string | null
    actor_name: string
    action: string
    resource_type: string
    resource_id: string | null
    resource_name: string
    metadata: string
    created_at: string
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM activity_logs
       WHERE household_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(householdId, limit, offset) as Row[]

  res.json(
    rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      metadata: (() => { try { return JSON.parse(r.metadata) } catch { return {} } })(),
      createdAt: r.created_at,
    })),
  )
})

export { router as activityLogsRouter }

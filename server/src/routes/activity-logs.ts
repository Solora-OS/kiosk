import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"

const router = Router()
router.use(requireAuth)

export type LogAction =
  | "event.create" | "event.update" | "event.delete"
  | "chore.create" | "chore.update" | "chore.delete" | "chore.complete" | "chore.uncomplete"
  | "reward.create" | "reward.update" | "reward.delete" | "reward.redeem" | "reward.approve" | "reward.decline"
  | "photo.add" | "photo.delete"
  | "away.set" | "away.end"
  | "hub.command"
  | "member.join"
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

/**
 * writeLog for the signed-in caller: the member behind the token, or "Wall
 * display" when the shared wall did it (it can't tell who tapped).
 */
export function logActivity(req: Request, entry: Omit<LogInput, "householdId" | "actorId" | "actorName">): void {
  const user = (req as AuthRequest).user
  if (!user?.householdId) return
  const wall = user.role === "kiosk"
  writeLog({ ...entry, householdId: user.householdId, actorId: wall ? null : user.sub, actorName: wall ? "Wall display" : undefined })
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

// ---------------------------------------------------------------------------
// Reading it back: one plain sentence per entry, grouped into categories the
// apps filter by. Kept here so mobile and the wall say exactly the same thing.
// ---------------------------------------------------------------------------

export type ActivityCategory = "calendar" | "chores" | "lists" | "meals" | "family" | "hub"

const CATEGORY_PREFIXES: Array<[ActivityCategory, string[]]> = [
  ["calendar", ["event.", "calendar.", "provider."]],
  ["chores", ["chore.", "reward."]],
  ["lists", ["list."]],
  ["meals", ["meal."]],
  ["family", ["member.", "away.", "photo."]],
  ["hub", ["hub.", "solora.", "support.", "device."]],
]

export function categoryOf(action: string): ActivityCategory {
  return CATEGORY_PREFIXES.find(([, ps]) => ps.some((p) => action.startsWith(p)))?.[0] ?? "hub"
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s)

/** "Maya added Dentist to the calendar". `actor` is already resolved. */
export function describeActivity(action: string, actor: string, name: string, meta: Record<string, unknown>): string {
  const it = name ? `“${name}”` : ""
  const summary = typeof meta.summary === "string" ? meta.summary : ""
  if (action.startsWith("solora.")) return summary ? `Solora ${lowerFirst(summary)}` : "Solora made a change to your hub"
  if (action.startsWith("support.") || action.startsWith("device.")) return summary ? `${actor} ${lowerFirst(summary)}` : `${actor} changed Solora's access`
  switch (action) {
    case "event.create":    return `${actor} added ${it} to the calendar`
    case "event.update":    return `${actor} changed ${it}`
    case "event.delete":    return `${actor} removed ${it} from the calendar`
    case "calendar.create": return `${actor} added the calendar ${it}`
    case "calendar.update": return `${actor} changed the calendar ${it}`
    case "calendar.delete": return `${actor} removed the calendar ${it}`
    case "provider.connect":    return `${actor} connected ${name || "a calendar account"}`
    case "provider.disconnect": return `${actor} disconnected ${name || "a calendar account"}`
    case "chore.create":     return `${actor} added the chore ${it}`
    case "chore.update":     return `${actor} changed the chore ${it}`
    case "chore.delete":     return `${actor} removed the chore ${it}`
    case "chore.complete":   return `${actor} finished ${it}`
    case "chore.uncomplete": return `${actor} un-checked ${it}`
    case "reward.create":  return `${actor} added the reward ${it}`
    case "reward.update":  return `${actor} changed the reward ${it}`
    case "reward.delete":  return `${actor} removed the reward ${it}`
    case "reward.redeem":  return `${actor} asked for ${it}`
    case "reward.approve": return `${actor} said yes to ${it}${typeof meta.for === "string" && meta.for ? ` for ${meta.for}` : ""}`
    case "reward.decline": return `${actor} said not this time to ${it}${typeof meta.for === "string" && meta.for ? ` for ${meta.for}` : ""}`
    case "list.create": return `${actor} started the list ${it}`
    case "list.delete": return `${actor} deleted the list ${it}`
    case "meal.create": return `${actor} planned ${it}`
    case "meal.update": return `${actor} changed the meal ${it}`
    case "meal.delete": return `${actor} removed ${it} from the meal plan`
    case "member.create":        return `${actor} added ${name || "someone"} to the family`
    case "member.update":        return `${actor} updated ${name ? `${name}’s` : "a"} profile`
    case "member.delete":        return `${actor} removed ${name || "someone"} from the family`
    case "member.invite":        return `${actor} invited ${name || "someone"}`
    case "member.invite_cancel": return `${actor} cancelled ${name ? `${name}’s` : "an"} invite`
    case "member.join":          return `${name || actor} joined the family`
    case "away.set": return `${actor} marked the family away${name ? `: ${name}` : ""}`
    case "away.end": return `${actor} marked the family back home`
    case "photo.add":    return `${actor} added a photo`
    case "photo.delete": return `${actor} removed a photo`
    case "hub.command":       return `${actor} ${name || "sent a command to the wall display"}`
    case "hub.restart":       return `${actor} restarted the hub`
    case "hub.factory_reset": return `${actor} reset the hub`
    default: return `${actor}: ${action}`
  }
}

// GET /api/v1/activity-logs?limit=50&category=chores&before=<createdAt>
//   newest first; page back with `before` = the last entry's createdAt.
//   `offset` still works for older callers.
router.get("/", (req: Request, res: Response) => {
  const { householdId } = (req as AuthRequest).user
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200)
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0)
  const before = typeof req.query.before === "string" ? req.query.before : null
  const category = typeof req.query.category === "string" ? req.query.category as ActivityCategory : null
  const prefixes = category ? CATEGORY_PREFIXES.find(([c]) => c === category)?.[1] : null
  if (category && !prefixes) {
    res.status(400).json({ error: "category must be calendar, chores, lists, meals, family or hub." })
    return
  }

  type Row = {
    id: string
    actor_id: string | null
    actor_name: string
    action: string
    resource_type: string
    resource_id: string | null
    resource_name: string
    metadata: string
    created_at: string
  }

  const where = ["household_id = ?"]
  const args: unknown[] = [householdId]
  if (before) { where.push("created_at < ?"); args.push(before) }
  if (prefixes) {
    where.push(`(${prefixes.map(() => "action LIKE ?").join(" OR ")})`)
    args.push(...prefixes.map((p) => `${p}%`))
  }
  const rows = getDb()
    .prepare(`SELECT * FROM activity_logs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as Row[]

  res.json(
    rows.map((r) => {
      const metadata = (() => { try { return JSON.parse(r.metadata) as Record<string, unknown> } catch { return {} } })()
      const bySolora = r.action.startsWith("solora.")
      const actor = bySolora ? "Solora" : r.actor_name || "Someone"
      // Families talk in first names: "Maya added…", not "Maya Okafor added…".
      // The wall can't tell who tapped it.
      const short = actor === "Wall display" ? "Someone at the wall" : actor.split(" ")[0]
      const summary = describeActivity(r.action, short, r.resource_name, metadata)
      return {
        id: r.id,
        actorId: r.actor_id,
        actorName: actor,
        action: r.action,
        category: categoryOf(r.action),
        summary,
        /** The words the summary starts with that name who did it, for the apps to set in bold. */
        lead: summary.startsWith(short) ? short : "",
        bySolora,
        reason: typeof metadata.reason === "string" ? metadata.reason : null,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        resourceName: r.resource_name,
        metadata,
        // Solora rows carry when Solora acted; the row itself is when the hub heard about it.
        createdAt: bySolora && typeof metadata.at === "string" ? metadata.at : r.created_at,
        cursor: r.created_at,
      }
    }),
  )
})

export { router as activityLogsRouter }

/**
 * support.ts — Settings › Privacy & support in the app. Household admins only.
 *
 *   GET  /api/v1/support/activity              what Solora did to this hub, newest first
 *   GET  /api/v1/support/grants                Solora's support access requests and grants
 *   POST /api/v1/support/grants/:id/respond    { decision: "grant" | "deny" }
 *   POST /api/v1/support/grants/:id/revoke     end access now
 *   POST /api/v1/support/devices/:id/lost      { lost: boolean } lock a wall display reported lost (or unlock it)
 *
 * Grants and locks are decided by central (central/src/routes/household.ts);
 * this hub calls it as itself. Contract source: mobile/src/app/settings/privacy-support-section.tsx.
 */

import { Router, type NextFunction, type Request, type Response } from "express"
import { getDb, parseJson } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { callerMember } from "../lib/household-member"
import { getCentralKioskCredentials } from "../lib/central-registry"
import { writeLog } from "./activity-logs"
import { CentralUnavailableError, centralFetch, type HouseholdGrant } from "../services/solora-support"

export const supportRouter = Router()
supportRouter.use(requireAuth)

/** Only household admins decide what Solora may do. Not the wall display. */
function adminsOnly(req: Request, res: Response, next: NextFunction): void {
  const m = callerMember((req as AuthRequest).user)
  if (m?.role !== "admin") {
    res.status(403).json({ error: "Only family admins can manage Solora's access." })
    return
  }
  next()
}
supportRouter.use(adminsOnly)

/** Runs a central call, answering 503 when central can't be reached. */
function viaCentral(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: Error & { status?: number }) => {
      const status = err instanceof CentralUnavailableError ? 503 : err.status && err.status < 500 ? err.status : 502
      res.status(status).json({ error: err.message })
    })
  }
}

supportRouter.get("/activity", (req: Request, res: Response) => {
  const { householdId } = (req as AuthRequest).user
  const rows = getDb().prepare(
    `SELECT id, action, resource_type, resource_name, metadata, created_at FROM activity_logs
      WHERE household_id = ? AND (action LIKE 'solora.%' OR action LIKE 'support.%' OR action IN ('device.reported_lost', 'device.found'))
      ORDER BY created_at DESC LIMIT 100`,
  ).all(householdId) as { id: string; action: string; resource_type: string; resource_name: string; metadata: string; created_at: string }[]
  res.json(rows.map((r) => {
    const meta = parseJson<Record<string, unknown>>(r.metadata, {})
    return {
      id:         r.id,
      action:     r.action,
      bySolora:   r.action.startsWith("solora."),
      summary:    typeof meta.summary === "string" ? meta.summary : r.action,
      reason:     typeof meta.reason === "string" ? meta.reason : null,
      deviceName: r.resource_name || null,
      at:         typeof meta.at === "string" ? meta.at : r.created_at,
    }
  }))
})

supportRouter.get("/grants", viaCentral(async (_req, res) => {
  res.json(await centralFetch<{ grants: HouseholdGrant[] }>("/household/support-grants"))
}))

supportRouter.post("/grants/:id/respond", viaCentral(async (req, res) => {
  const decision = (req.body as { decision?: unknown }).decision
  if (decision !== "grant" && decision !== "deny") {
    res.status(400).json({ error: "decision must be \"grant\" or \"deny\"." })
    return
  }
  const { grant } = await centralFetch<{ grant: HouseholdGrant }>(
    `/household/support-grants/${encodeURIComponent(req.params.id)}/respond`, { method: "POST", body: { decision } },
  )
  const user = (req as AuthRequest).user
  writeLog({
    householdId: user.householdId!, actorId: user.userId,
    action: decision === "grant" ? "support.granted" : "support.denied",
    resourceType: "support_grant", resourceId: grant.id,
    metadata: {
      reason: grant.reason,
      summary: decision === "grant"
        ? `Allowed Solora Support to read diagnostics for ${grant.duration_hours} hours`
        : "Denied Solora Support's request for diagnostics",
    },
  })
  res.json({ grant })
}))

supportRouter.post("/grants/:id/revoke", viaCentral(async (req, res) => {
  const { grant } = await centralFetch<{ grant: HouseholdGrant }>(
    `/household/support-grants/${encodeURIComponent(req.params.id)}/revoke`, { method: "POST" },
  )
  const user = (req as AuthRequest).user
  writeLog({
    householdId: user.householdId!, actorId: user.userId, action: "support.revoked",
    resourceType: "support_grant", resourceId: grant.id, metadata: { summary: "Ended Solora Support's access" },
  })
  res.json({ grant })
}))

supportRouter.post("/devices/:id/lost", viaCentral(async (req, res) => {
  const lost = (req.body as { lost?: unknown }).lost
  if (typeof lost !== "boolean") {
    res.status(400).json({ error: "lost must be true or false." })
    return
  }
  const user = (req as AuthRequest).user
  const kiosk = getDb().prepare("SELECT id, device_name FROM kiosk_devices WHERE id = ? AND household_id = ?")
    .get(req.params.id, user.householdId) as { id: string; device_name: string } | undefined
  if (!kiosk) {
    res.status(404).json({ error: "Display not found." })
    return
  }
  const creds = getCentralKioskCredentials(kiosk.id)
  if (!creds) {
    res.status(409).json({ error: "This display isn't connected to Solora's service, so it can't be locked remotely." })
    return
  }
  const out = await centralFetch<{ locked: boolean; delivered: boolean }>(
    `/household/devices/${creds.central_device_id}/lock`, { method: "POST", body: { locked: lost } },
  )
  writeLog({
    householdId: user.householdId!, actorId: user.userId,
    action: lost ? "device.reported_lost" : "device.found",
    resourceType: "kiosk", resourceId: kiosk.id, resourceName: kiosk.device_name,
    metadata: { summary: lost ? `Reported ${kiosk.device_name} lost and locked it` : `Unlocked ${kiosk.device_name}` },
  })
  res.json({ locked: out.locked, delivered: out.delivered })
}))

/**
 * /api/v1/transfer — moving a household to a new hub (see services/hub-transfer.ts).
 *
 *   Old hub:
 *     POST /start            (admin)          → { code, expiresAt }
 *     GET  /export           X-Transfer-Code  → sealed household archive
 *     GET  /photo/:filename  X-Transfer-Code  → sealed photo bytes
 *     POST /finish           X-Transfer-Code  → ends the move
 *   New hub:
 *     POST /pull             (this hub's own screen, before setup) { code, from? } → summary
 */

import { Router, type Request, type Response } from "express"
import { requireAdmin, requireAuth, type AuthRequest } from "../middleware/auth"
import {
  exportHousehold, finishTransfer, householdForCode, pullHousehold, readHouseholdPhoto, seal,
  normalizeTransferCode, startTransfer, TransferError,
} from "../services/hub-transfer"
import { normalizeHubAddress } from "../lib/hub-address"
import { fromThisHub } from "../lib/loopback"

export const transferRouter = Router()

transferRouter.post("/start", requireAuth, requireAdmin, (req: Request, res: Response) => {
  res.json(startTransfer((req as AuthRequest).user.householdId!))
})

function codeFrom(req: Request): { code: string; householdId: string } | null {
  const raw = req.header("X-Transfer-Code")
  const householdId = householdForCode(raw)
  return householdId ? { code: normalizeTransferCode(raw ?? ""), householdId } : null
}

transferRouter.get("/export", (req: Request, res: Response) => {
  const auth = codeFrom(req)
  if (!auth) { res.status(403).json({ error: "Invalid or expired transfer code." }); return }
  const archive = Buffer.from(JSON.stringify(exportHousehold(auth.householdId)), "utf8")
  res.type("application/octet-stream").send(seal(auth.code, archive))
})

transferRouter.get("/photo/:filename", (req: Request, res: Response) => {
  const auth = codeFrom(req)
  if (!auth) { res.status(403).json({ error: "Invalid or expired transfer code." }); return }
  const data = readHouseholdPhoto(auth.householdId, req.params.filename)
  if (!data) { res.status(404).json({ error: "Photo not found." }); return }
  res.type("application/octet-stream").send(seal(auth.code, data))
})

transferRouter.post("/finish", (req: Request, res: Response) => {
  if (!codeFrom(req)) { res.status(403).json({ error: "Invalid or expired transfer code." }); return }
  finishTransfer()
  res.status(204).end()
})

/**
 * Only this hub's own screen may start a pull, and only before setup: being in
 * front of the new hub plus the code from the old one is the authority to move.
 */
transferRouter.post("/pull", async (req: Request, res: Response) => {
  if (!fromThisHub(req)) {
    res.status(403).json({ error: "Moving a household is only started on the new hub's own screen." })
    return
  }
  const { code, from } = req.body as { code?: string; from?: string }
  if (!code?.trim()) { res.status(400).json({ error: "Enter the transfer code from your phone." }); return }
  const fromUrl = from?.trim() ? normalizeHubAddress(from) : undefined
  if (from?.trim() && !fromUrl) { res.status(400).json({ error: "That doesn't look like a hub address, e.g. 192.168.1.20." }); return }
  try {
    res.json(await pullHousehold(code, fromUrl ?? undefined))
  } catch (e) {
    if (e instanceof TransferError) { res.status(409).json({ error: e.message }); return }
    console.error("[transfer] pull failed:", e)
    res.status(500).json({ error: "The move didn't finish. Nothing was changed; try again." })
  }
})

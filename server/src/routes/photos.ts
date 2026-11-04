/**
 * routes/photos.ts
 *
 * Photos are stored as files in $HOME/.solora/photos/<id>.<ext> and served
 * as static files at GET /photos/:id.  The DB stores only the filename and
 * a relative URL.
 *
 * POST /photos          — multipart upload (field name: "file") + optional caption
 * GET  /photos          — list all photo metadata for the household
 * DELETE /photos/:id    — delete photo file + DB row
 *
 * Static serving of the actual image files is handled in index.ts via
 * express.static pointed at PHOTOS_DIR.
 */

import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import multer from "multer"
import path from "path"
import fs from "fs"
import { getDb, PHOTOS_DIR } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { Photo } from "../types"
import { logActivity } from "./activity-logs"

const router = Router()
router.use(requireAuth)

// Multer — store to disk with a uuid filename to avoid collisions.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PHOTOS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg"
    cb(null, `${uuidv4()}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"]
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error("Only image files are allowed."))
  },
})

function rowToPhoto(r: Record<string, unknown>): Photo {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    filename: r.filename as string,
    src: r.src as string,
    caption: r.caption as string,
    createdAt: r.created_at as string,
  }
}

// GET /photos
router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM photos WHERE household_id = ? ORDER BY created_at DESC")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToPhoto))
})

// POST /photos — multipart/form-data with field "file"
router.post("/", upload.single("file"), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." })
    return
  }
  const householdId = (req as AuthRequest).user.householdId!
  const { caption = "" } = req.body as { caption?: string }
  const id = uuidv4()
  const filename = req.file.filename
  // Serve photos via /photo-files/<filename> (mounted in index.ts)
  const src = `/photo-files/${filename}`

  getDb()
    .prepare("INSERT INTO photos (id, household_id, filename, src, caption) VALUES (?, ?, ?, ?, ?)")
    .run(id, householdId, filename, src, caption.trim())

  const row = getDb().prepare("SELECT * FROM photos WHERE id = ?").get(id) as Record<string, unknown>
  const photo = rowToPhoto(row)
  logActivity(req, { action: "photo.add", resourceType: "photo", resourceId: photo.id })
  broadcast(householdId, "photos:created", photo)
  res.status(201).json(photo)
})

// DELETE /photos/:id
// ---------------------------------------------------------------------------
// Photos for the phones, at home or away. /photo-files only takes device
// tokens and a URL the phone can't build, so the apps use these instead.
// Away from home everything goes through the encrypted relay, which carries
// JSON, so photos travel as base64 in pieces small enough for it.
// ---------------------------------------------------------------------------

const CHUNK_BYTES = 512 * 1024
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic" }

function photoFile(householdId: string, id: string): { file: string; mime: string } | null {
  const row = getDb().prepare("SELECT filename FROM photos WHERE id = ? AND household_id = ?").get(id, householdId) as
    | { filename: string }
    | undefined
  if (!row) return null
  const file = path.join(PHOTOS_DIR, path.basename(row.filename))
  if (!fs.existsSync(file)) return null
  return { file, mime: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" }
}

// GET /photos/:id/file — the image, for any household sign-in (phone, kid's phone, wall).
router.get("/:id/file", (req: Request, res: Response) => {
  const found = photoFile((req as AuthRequest).user.householdId!, req.params.id)
  if (!found) { res.status(404).json({ error: "Photo not found." }); return }
  res.type(found.mime).sendFile(found.file, { maxAge: "1d" })
})

// GET /photos/:id/chunk?part=0 — the image as base64, 512 KB at a time, for the relay.
router.get("/:id/chunk", (req: Request, res: Response) => {
  const found = photoFile((req as AuthRequest).user.householdId!, req.params.id)
  if (!found) { res.status(404).json({ error: "Photo not found." }); return }
  const size = fs.statSync(found.file).size
  const parts = Math.max(1, Math.ceil(size / CHUNK_BYTES))
  const part = Number(req.query.part ?? 0)
  if (!Number.isInteger(part) || part < 0 || part >= parts) { res.status(404).json({ error: "No such part." }); return }
  const fd = fs.openSync(found.file, "r")
  try {
    const length = Math.min(CHUNK_BYTES, size - part * CHUNK_BYTES)
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, part * CHUNK_BYTES)
    res.json({ mime: found.mime, part, parts, data: buf.toString("base64") })
  } finally {
    fs.closeSync(fd)
  }
})

// POST /photos/base64 { data, mime, caption } — an upload that fits the relay
// (the apps shrink photos first, so this stays well under the body limit).
router.post("/base64", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { data, mime, caption = "" } = req.body as { data?: string; mime?: string; caption?: string }
  const ext = Object.entries(MIME).find(([, m]) => m === mime)?.[0]
  if (!data || !ext) { res.status(400).json({ error: "Send a JPEG, PNG, WebP, GIF or HEIC image." }); return }
  const bytes = Buffer.from(data, "base64")
  if (bytes.length === 0 || bytes.length > 3 * 1024 * 1024) { res.status(413).json({ error: "That photo is too large." }); return }
  const id = uuidv4()
  const filename = `${uuidv4()}${ext === ".jpeg" ? ".jpg" : ext}`
  fs.mkdirSync(PHOTOS_DIR, { recursive: true })
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), bytes)
  getDb()
    .prepare("INSERT INTO photos (id, household_id, filename, src, caption) VALUES (?, ?, ?, ?, ?)")
    .run(id, householdId, filename, `/photo-files/${filename}`, String(caption).trim().slice(0, 200))
  const photo = rowToPhoto(getDb().prepare("SELECT * FROM photos WHERE id = ?").get(id) as Record<string, unknown>)
  logActivity(req, { action: "photo.add", resourceType: "photo", resourceId: photo.id })
  broadcast(householdId, "photos:created", photo)
  res.status(201).json(photo)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const row = db
    .prepare("SELECT * FROM photos WHERE id = ? AND household_id = ?")
    .get(id, householdId) as Record<string, unknown> | undefined

  if (!row) {
    res.status(404).json({ error: "Photo not found." })
    return
  }

  // Delete the file from disk (best-effort)
  const filePath = path.join(PHOTOS_DIR, row.filename as string)
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    // Non-fatal — continue with DB delete
  }

  db.prepare("DELETE FROM photos WHERE id = ? AND household_id = ?").run(id, householdId)
  logActivity(req, { action: "photo.delete", resourceType: "photo", resourceId: id })
  broadcast(householdId, "photos:deleted", id)
  res.status(204).end()
})

export { router as photosRouter }

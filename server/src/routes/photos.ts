/**
 * routes/photos.ts
 *
 * Photos are stored as files in $HOME/.lumora/photos/<id>.<ext> and served
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
  broadcast(householdId, "photos:created", photo)
  res.status(201).json(photo)
})

// DELETE /photos/:id
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
  broadcast(householdId, "photos:deleted", id)
  res.status(204).end()
})

export { router as photosRouter }

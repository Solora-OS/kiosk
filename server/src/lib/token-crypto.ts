/**
 * AES-256-GCM encryption/decryption for OAuth tokens stored in SQLite.
 * Key is derived from ~/.solora/.secret (generated on first boot by db.ts).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto"
import fs from "fs"
import path from "path"
import { SECRET_FILE } from "../db"

function getEncryptionKey(): Buffer {
  const secretPath = SECRET_FILE
  const secret = fs.readFileSync(secretPath, "utf8").trim()
  return createHash("sha256").update(secret).digest()
}

export function encryptToken(text: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

export function decryptToken(data: string): string {
  try {
    const key = getEncryptionKey()
    const buf = Buffer.from(data, "base64")
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const encrypted = buf.subarray(28)
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
  } catch {
    // Fallback: return raw value for tokens stored before encryption was added.
    return data
  }
}

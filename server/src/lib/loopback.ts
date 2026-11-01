/**
 * loopback.ts — whether a request comes from the hub machine itself.
 *
 * Being in front of the hub is proof of ownership: only its own screen sees
 * the setup code, starts a move, or gets linked to a new household by setup.
 */

import type { Request } from "express"

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function fromThisHub(req: Request): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "")
}

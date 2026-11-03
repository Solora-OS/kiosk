"use client"

import { ensureRegistered, getDeviceToken } from "./kiosk-session"

/**
 * Device Registration service ("Solora Cloud enrollment").
 *
 * This is the abstraction the startup flow uses for step 2 — registering the
 * device with Solora Cloud (MDM). Today it is backed by the existing Supabase
 * `kiosk_register` RPC, which is the source of truth for device enrollment.
 *
 * The UI never calls `kiosk_register` directly; it goes through this service.
 * That means a dedicated MDM platform can be introduced later by swapping the
 * implementation of `registerDevice()` without touching any screens or the
 * startup state machine.
 */

export type RegistrationResult = {
  /** The opaque device token that identifies this device to the backend. */
  deviceToken: string
}

/** True if this device already has a registration token stored locally. */
export function isDeviceRegistered(): boolean {
  return !!getDeviceToken()
}

/**
 * Ensure this device is enrolled with Solora Cloud.
 *
 * Idempotent: if the device is already registered the existing token is
 * returned. On first launch it enrolls via the backend and persists the token.
 * Throws on failure so the caller can show the retry screen.
 */
export async function registerDevice(deviceName?: string): Promise<RegistrationResult> {
  const token = await ensureRegistered(deviceName)
  if (!token) {
    throw new Error("Enrollment did not return a device token.")
  }
  return { deviceToken: token }
}

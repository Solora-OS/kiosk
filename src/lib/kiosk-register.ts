// ---------------------------------------------------------------------------
// kiosk-register.ts
//
// Thin wrapper kept for backward compatibility.
// Previously called Supabase directly; now delegates to kiosk-session which
// calls the local Express server.
// ---------------------------------------------------------------------------

import { ensureRegistered, getDeviceName } from "./kiosk-session"
import { LOCAL_API_BASE, tokenStore } from "./local-api"

export interface KioskRegistration {
  id: string
  household_id: string
  device_name: string
  is_registered: boolean
  claimed_at: string | null
}

/** Check if kiosk is registered; register it if not. */
export async function registerOrClaimKiosk(
  householdId: string,
  deviceName = "Kiosk Display",
): Promise<KioskRegistration> {
  await ensureRegistered(deviceName)

  // Look up the current device record from the local server.
  const token = tokenStore.get()
  const res = await fetch(`${LOCAL_API_BASE}/api/v1/kiosk/state`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (!res.ok) {
    return {
      id: "",
      household_id: householdId,
      device_name: deviceName || getDeviceName(),
      is_registered: false,
      claimed_at: null,
    }
  }

  const data = await res.json() as {
    device_id?: string
    household_id?: string
    device_name?: string
    found?: boolean
  }

  return {
    id: data.device_id ?? "",
    household_id: data.household_id ?? householdId,
    device_name: data.device_name ?? deviceName,
    is_registered: !!data.found,
    claimed_at: null,
  }
}

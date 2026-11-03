# Kiosk Pairing Contract (iOS app ↔ Supabase)

How a family member claims a wall-mounted Solora kiosk to their household using
the mobile app. The kiosk itself is **not a user** — it holds a secret
`device_token` and talks to the backend only through `SECURITY DEFINER` RPCs.

## Concepts

- **Device token** — a long random secret generated once per physical kiosk
  (`kiosk_register`), stored in the kiosk's `localStorage`. Identifies the device
  to all kiosk RPCs. Never leaves the kiosk.
- **Pairing code** — a short, human-readable 8-char uppercase code (e.g.
  `A1B2C3D4`) shown on the kiosk screen + encoded in its QR. This is what the
  iOS app sends to claim the device. Safe to display.
- **Claim** — an authenticated household member binds a pairing code to their
  `household_id`. From then on the kiosk can read that household's data.

## Kiosk lifecycle (already implemented in this app)

1. On first launch, kiosk calls `kiosk_register(p_device_name)` → stores
   `device_token`, displays `pairing_code` as text + QR.
2. Kiosk polls `kiosk_get_state(device_token)` every ~3s. While `paired = false`
   it shows the pairing screen.
3. Once a member claims it, `kiosk_get_state` returns `paired = true` +
   `household_id`, and the kiosk loads the dashboard via
   `kiosk_fetch_all(device_token)`.
4. Kiosk reports status via `kiosk_heartbeat(...)` on a 30s cadence.

## QR payload

The kiosk encodes this deep link in the QR code:

```
lumora://claim-kiosk?code=<PAIRING_CODE>
```

The iOS app should register the `lumora://` URL scheme (or a Universal Link
equivalent), parse `code`, and proceed to the claim call below. If you prefer a
Universal Link, swap the scheme but keep the `code` query parameter.

## What the iOS app must implement

### 1. Scan / parse
Parse the `code` query parameter from the scanned QR (or let the user type the
8-char code shown on the kiosk).

### 2. Resolve the target household
The signed-in user may belong to multiple households. Pick the household to
attach the kiosk to (default to the user's current/primary household, or prompt
if there are several). You need its `household_id` (uuid).

### 3. Call the claim RPC (authenticated)
With the member's Supabase auth session active:

```ts
const { data, error } = await supabase.rpc("kiosk_claim", {
  p_pairing_code: code,        // e.g. "A1B2C3D4" (case-insensitive, trimmed)
  p_household_id: householdId, // uuid of the household to attach to
})
// data: { device_id: uuid, device_name: string }
```

**Server-side guarantees (enforced in `kiosk_claim`):**
- Caller must be authenticated (`auth.uid()` not null).
- Caller must be a member of `p_household_id` (checked against `public.members`).
- The pairing code must exist and still be unclaimed (`household_id IS NULL`).
- On success the device row is set to `household_id = p_household_id`,
  `claimed_by = auth.uid()`, `claimed_at = now()`.

**Errors (thrown as Postgres exceptions, surfaced in `error.message`):**
- `Authentication required`
- `Not a member of this household`
- `Invalid or already-claimed pairing code`

Within a couple seconds the kiosk's `kiosk_get_state` poll flips to `paired` and
the dashboard loads automatically. No further action needed on the kiosk.

### 4. (Optional) List / manage claimed kiosks
To show household members which displays are connected and let them remove one:

```ts
// List kiosks for a household (normal RLS SELECT — members can read their own)
const { data: kiosks } = await supabase
  .from("kiosk_devices")
  .select("id, device_name, is_online, last_heartbeat, wifi_signal, ping_latency_ms, battery_percent, claimed_at")
  .eq("household_id", householdId)

// Remove a kiosk from the household (authenticated, member-only)
await supabase.rpc("kiosk_unclaim_by_id", { p_device_id: kioskId })
```

`kiosk_unclaim_by_id` verifies the caller is a member of the kiosk's household,
then detaches it and issues a fresh pairing code so the device returns to its
pairing screen, ready to be claimed by a different household.

## RPC reference

| RPC | Caller | Args | Returns |
| --- | --- | --- | --- |
| `kiosk_register` | kiosk (anon) | `p_device_name text` | `{ device_id, device_token, pairing_code }` |
| `kiosk_get_state` | kiosk (anon) | `p_device_token text` | `{ found, device_id, device_name, paired, pairing_code, household_id, household_name }` |
| `kiosk_heartbeat` | kiosk (anon) | `p_device_token, p_wifi, p_ping, p_battery, p_device_info` | `boolean` |
| `kiosk_fetch_all` | kiosk (anon) | `p_device_token text` | household snapshot json |
| `kiosk_unclaim` | kiosk (anon) | `p_device_token text` | `{ pairing_code }` |
| **`kiosk_claim`** | **iOS (authed)** | `p_pairing_code text, p_household_id uuid` | `{ device_id, device_name }` |
| **`kiosk_unclaim_by_id`** | **iOS (authed)** | `p_device_id uuid` | `boolean` |

## Security notes

- The kiosk RPCs accept a `device_token`, not a user session. The token is the
  bearer of authority for that one device and is only ever stored on the kiosk.
- `kiosk_fetch_all` returns data **only** for the household the device is
  currently claimed to; an unclaimed device gets an error.
- Claiming/unclaiming require a real authenticated household member — the kiosk
  cannot attach itself to a household, only a member can.
- Re-homing: unclaiming (from either side) wipes `household_id`/`claimed_by` and
  rotates the pairing code, so a kiosk can be safely moved to a different
  household/account without leaking the previous household's data.

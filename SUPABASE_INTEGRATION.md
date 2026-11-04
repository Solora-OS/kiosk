# Supabase Integration Summary

This document summarizes the changes made to integrate the kiosk app with Supabase for realtime sync with the iOS app.

## What Was Changed

### 1. Database Schema
**File**: `supabase/migrations/create_kiosk_devices.sql`

Added new `kiosk_devices` table to track kiosk status:
- `id` (UUID, primary key)
- `household_id` (FK to households, RLS scoped)
- `device_name` (e.g., "Kiosk Display")
- `wifi_signal` (integer -30 to -90 dBm)
- `ping_latency_ms` (round-trip time to Supabase)
- `battery_percent` (0-100)
- `device_info` (JSON: platform, userAgent, timezone)
- `is_online` (boolean)
- `last_heartbeat` (timestamp)

RLS policies ensure only household members can view/update their kiosk status.

### 2. Kiosk Status Service
**File**: `src/lib/kiosk-status.ts` (NEW)

Provides realtime device status tracking:
- `startKioskStatusTracking(householdId, deviceName)` - Starts 30-second status publishing
- `stopKioskStatusTracking()` - Stops publishing
- `subscribeToKioskStatus(householdId, callback)` - Subscribe to status changes
- Automatic metrics collection:
  - WiFi signal estimation
  - Ping latency measurement
  - Battery level (if available)
  - Device platform info

### 3. Authentication Integration
**File**: `src/lib/auth.tsx`

Added automatic kiosk status tracking:
- When user signs in, `startKioskStatusTracking()` is called if kiosk is enabled
- When user signs out, `stopKioskStatusTracking()` is called
- Kiosk mode auto-signs in admin on app start

### 4. Store Updates
**File**: `src/lib/store.tsx`

Added realtime kiosk device subscriptions:
- New state: `kioskDevices: KioskDeviceStatus[]`
- Added `kiosk_devices` to realtime subscription list
- Automatic reconciliation of kiosk status updates
- iOS app can access via: `const { kioskDevices } = useStore()`

### 5. Kiosk Configuration
**File**: `src/lib/kiosk.ts`

Updated config structure:
- `enabled` - True if kiosk mode is active (starts status tracking)
- `autoSignIn` - Auto-login with stored credentials
- `hideSignOut` - Hide sign-out button in kiosk mode
- `adminEmail` / `adminPassword` - For auto-signin

### 6. Settings UI
**File**: `src/app/settings/settings.tsx`

Hide sign-out button when kiosk is enabled:
```typescript
{!kioskConfig.enabled && !kioskConfig.hideSignOut ? (
  <ActionRow icon={LogOut} label="Sign out" />
) : null}
```

## Environment Variables

### Required for Supabase
```bash
VITE_SUPABASE_URL=https://supabase-pink-yacht.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### Required for Kiosk
```bash
REACT_APP_KIOSK_MODE=true
REACT_APP_KIOSK_AUTO_SIGNIN=true
REACT_APP_KIOSK_ADMIN_EMAIL=admin@household.com
REACT_APP_KIOSK_ADMIN_PASSWORD=secure-password
```

## How It Works

### Kiosk Status Publishing

1. Kiosk app signs in automatically (if `REACT_APP_KIOSK_AUTO_SIGNIN=true`)
2. `AuthProvider` calls `startKioskStatusTracking(householdId)`
3. Every 30 seconds, kiosk publishes:
   - WiFi signal strength (estimated from ping latency)
   - Ping latency to Supabase
   - Battery percentage
   - Device platform info
   - Heartbeat timestamp
4. Data is upserted to `kiosk_devices` table

### iOS App Real-time Sync

1. iOS app signs into same Supabase project
2. `StoreProvider` subscribes to all tables including `kiosk_devices`
3. When kiosk publishes status update:
   - Supabase Realtime sends change event
   - iOS app receives via WebSocket
   - `kioskDevices` state updates automatically
4. iOS UI can display:
   - WiFi signal
   - Ping latency
   - Battery level
   - Last heartbeat time
   - Online status

## Realtime Subscription Flow

```typescript
// In store.tsx
const tables = [
  "members",
  "calendars",
  "events",
  "chores",
  "lists",
  "list_items",
  "meals",
  "notifications",
  "notification_states",
  "photos",
  "households",
  "kiosk_devices",  // NEW
]

let ch = supabase.channel("solora-realtime")
for (const table of tables) {
  ch = ch.on("postgres_changes", { event: "*", schema: "public", table }, scheduleSync)
}
channel = ch.subscribe()
```

## RLS Protection

The `kiosk_devices` table uses RLS to ensure:

1. **Select**: Only household members can view their kiosk status
   ```sql
   WHERE household_id IN (
     SELECT household_id FROM members WHERE user_id = auth.uid()
   )
   ```

2. **Insert/Update**: Only authenticated household members can publish status
   ```sql
   WHERE household_id IN (
     SELECT household_id FROM members WHERE user_id = auth.uid()
   )
   ```

## TypeScript Types

```typescript
// From src/lib/kiosk-status.ts
interface KioskDeviceStatus {
  id: string
  household_id: string
  device_name: string
  wifi_signal: number        // -30 to -90 dBm
  ping_latency_ms: number    // ms
  battery_percent?: number   // 0-100
  device_info?: string       // JSON
  last_heartbeat: string     // ISO timestamp
  is_online: boolean
}
```

## Testing

### Test in SQL Editor

```sql
-- View current kiosk status
SELECT * FROM kiosk_devices;

-- Check if it's updating (should change every 30s)
SELECT 
  device_name,
  ping_latency_ms,
  is_online,
  NOW() - last_heartbeat as age
FROM kiosk_devices;
```

### Test in iOS App

```typescript
import { useStore } from '@/lib/store'

// In component
const { kioskDevices } = useStore()
console.log('Kiosk status:', kioskDevices[0])

// Should auto-update every 30 seconds via realtime
```

### Test Locally

```bash
# Create .env.local
VITE_SUPABASE_URL=https://supabase-pink-yacht.supabase.co
VITE_SUPABASE_ANON_KEY=your-key
REACT_APP_KIOSK_MODE=true
REACT_APP_KIOSK_AUTO_SIGNIN=true
REACT_APP_KIOSK_ADMIN_EMAIL=admin@household.com
REACT_APP_KIOSK_ADMIN_PASSWORD=password

# Start dev server
npm run dev

# Check browser console - should see status being published every 30s
```

## Deployment Checklist

- [ ] Apply `kiosk_devices` migration to Supabase
- [ ] Enable realtime replication for `kiosk_devices` table
- [ ] Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel
- [ ] Set `REACT_APP_KIOSK_*` variables in Vercel
- [ ] Deploy to Vercel
- [ ] Verify kiosk status appears in Supabase SQL Editor
- [ ] Verify iOS app sees kiosk status in realtime
- [ ] Test WiFi/ping metrics update every 30 seconds

## Files Changed

| File | Change |
|------|--------|
| `supabase/migrations/create_kiosk_devices.sql` | NEW - Database schema |
| `src/lib/kiosk-status.ts` | NEW - Status tracking service |
| `src/lib/kiosk.ts` | UPDATED - Config structure |
| `src/lib/auth.tsx` | UPDATED - Auto-start status tracking |
| `src/lib/store.tsx` | UPDATED - Realtime subscriptions |
| `src/app/settings/settings.tsx` | UPDATED - Hide sign-out logic |
| `KIOSK_SETUP.md` | UPDATED - Deployment guide |

## Backward Compatibility

All changes are additive - no breaking changes:
- Kiosk mode is opt-in via `REACT_APP_KIOSK_MODE=true`
- If disabled, app behaves like normal web app
- RLS policies only affect `kiosk_devices` table
- All existing tables unchanged

# Supabase Migration Setup: Kiosk Devices Table

This guide explains how to apply the `kiosk_devices` table migration to your live Supabase database.

## Why This Is Needed

The kiosk app needs to register itself in the `kiosk_devices` table so that:
- The iOS app can see the kiosk status (WiFi, ping, battery, online/offline)
- The kiosk publishes its health metrics every 30 seconds in realtime
- Users can monitor kiosk connectivity from the iOS app

## Option 1: Using Supabase CLI (Recommended)

### Prerequisites
- Install Supabase CLI: https://supabase.com/docs/guides/cli/getting-started
- Have your Supabase project linked

### Steps

1. **Link your project** (if not already linked):
```bash
cd kiosk
supabase link --project-ref <your-project-id>
```

2. **Push the migration** to your live database:
```bash
supabase db push
```

3. **Verify the migration was applied**:
```bash
supabase db pull
```

You should see `kiosk_devices` table in the schema.

## Option 2: Using Supabase Dashboard (Manual)

### Steps

1. **Open Supabase Dashboard**:
   - Go to https://app.supabase.com
   - Select your project (`supabase-pink-yacht`)
   - Go to **SQL Editor**

2. **Copy and run the migration SQL**:
   - Open `/supabase/migrations/create_kiosk_devices.sql`
   - Copy all the SQL
   - Paste into Supabase SQL Editor
   - Click **Run**

3. **Verify the table was created**:
   - Go to **Database** → **Tables**
   - You should see `kiosk_devices` table
   - Check for columns: `id`, `household_id`, `device_name`, `wifi_signal`, `ping_latency_ms`, `battery_percent`, `is_online`, `last_heartbeat`, `device_info`, `created_at`, `updated_at`

## Option 3: Using the SQL Content Directly

Here's the complete SQL to run in Supabase SQL Editor:

```sql
-- Create kiosk_devices table to track kiosk status in realtime
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT 'Kiosk Display',
  
  -- Network metrics
  wifi_signal INTEGER,
  ping_latency_ms INTEGER NOT NULL DEFAULT 0,
  is_online BOOLEAN NOT NULL DEFAULT true,
  
  -- Device info
  battery_percent INTEGER,
  device_info JSONB,
  
  -- Timestamps
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE(household_id, device_name)
);

-- Enable RLS
ALTER TABLE kiosk_devices ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "kiosk_devices_select_by_household" ON kiosk_devices
  FOR SELECT
  USING (
    household_id IN (
      SELECT household_id FROM members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "kiosk_devices_insert" ON kiosk_devices
  FOR INSERT
  WITH CHECK (
    household_id IN (
      SELECT household_id FROM members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "kiosk_devices_update" ON kiosk_devices
  FOR UPDATE
  USING (
    household_id IN (
      SELECT household_id FROM members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    household_id IN (
      SELECT household_id FROM members WHERE user_id = auth.uid()
    )
  );

-- Indexes for performance
CREATE INDEX idx_kiosk_devices_household_id ON kiosk_devices(household_id);
CREATE INDEX idx_kiosk_devices_updated_at ON kiosk_devices(updated_at DESC);

-- Auto-update timestamp
CREATE TRIGGER update_kiosk_devices_updated_at
BEFORE UPDATE ON kiosk_devices
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
```

## Verifying the Setup

After applying the migration, test it:

### From Supabase Dashboard
1. Go to **Table Editor**
2. Select `kiosk_devices` table
3. Should be empty (no records yet)
4. Columns should be visible

### From the Kiosk App
1. Start the kiosk app with your admin credentials:
   ```bash
   npm run tauri dev
   # Or with env vars:
   VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... npm run tauri dev
   ```

2. Check browser console (F12) for debug messages:
   ```
   [v0] Kiosk registration successful: <id>
   [v0] Publishing kiosk status: {...}
   ```

3. Go back to Supabase Dashboard → **Table Editor** → `kiosk_devices`
4. You should see a new row with your kiosk's status

### From the iOS App
1. Open Settings
2. Scroll to **Kiosk Status**
3. Should now show your kiosk's metrics:
   - Online/Offline status
   - WiFi signal
   - Ping latency
   - Battery (if available)
   - Last heartbeat

## Troubleshooting

### Migration fails with "update_updated_at_column() does not exist"

This function is usually created by Supabase automatically. If it's missing, add it:

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Table appears but kiosk won't register

Check:
1. Browser console for `[v0]` debug messages
2. Are Supabase env vars set correctly? (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
3. Is the kiosk signed into the correct household?
4. Do you have a Supabase session with valid auth token?

### iOS app doesn't see kiosk status

Make sure:
1. Migration is applied to Supabase (not just locally)
2. Realtime replication is enabled for `kiosk_devices` table:
   - Go to **Database** → **Replication**
   - Check that `kiosk_devices` is enabled for replication

## Next Steps

1. ✅ Apply this migration to your live Supabase
2. ✅ Start the kiosk app
3. ✅ Check iOS app Settings → Kiosk Status
4. ✅ Monitor kiosk connectivity in realtime

The kiosk will automatically register on first startup and publish status updates every 30 seconds.

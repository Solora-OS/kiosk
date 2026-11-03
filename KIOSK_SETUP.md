# Solora Kiosk Setup Guide

This guide covers deploying the Solora Kiosk application with full Supabase integration for realtime sync between the kiosk and iOS app.

## Overview

The kiosk application is designed to run as a permanent display device that:
- **Automatically signs in** as the household admin
- **Displays family data** in realtime (calendar, chores, lists, meals, photos)
- **Reports device status** (WiFi, ping latency, battery) to Supabase every 30 seconds
- **Uses side navigation** optimized for larger screens
- **Syncs all data in realtime** with the iOS app via Supabase Realtime subscriptions

## Architecture

```
┌─────────────────┐      Supabase Realtime    ┌──────────────┐
│   iOS App       │◄──────────────────────────►│  Supabase    │
│                 │  (PostgreSQL + Realtime)  │              │
│  - View kiosk   │                           │  - RLS       │
│  - Fetch status │                           │  - Auth      │
└─────────────────┘                           │  - Realtime  │
                                              └──────────────┘
                                                    ▲
                                                    │
                                                    │ Realtime
                                                    │ + HTTP
                                                    │
                                              ┌─────┴────────┐
                                              │ Kiosk App    │
                                              │              │
                                              │ - Auto-signin│
                                              │ - Status pub │
                                              │ - Side nav   │
                                              └──────────────┘
```

## Prerequisites

1. **Supabase Project**: A Supabase project with Solora schema already set up
2. **Admin Account**: A household admin user with email/password authentication
3. **Realtime Enabled**: All tables must have replication enabled for realtime
4. **Deployment Platform**: Vercel, Netlify, or similar (or run locally)

## Step 1: Database Setup

### Apply the Kiosk Devices Migration

The kiosk requires a `kiosk_devices` table to track device status. Apply this migration:

```bash
# If using Supabase CLI
supabase db push
```

Or manually run in Supabase SQL Editor:
```sql
-- Copy contents of: supabase/migrations/create_kiosk_devices.sql
```

This creates:
- `kiosk_devices` table with columns for WiFi, ping, battery, and heartbeat
- RLS policies protecting household-scoped data
- Indexes for efficient realtime queries

### Enable Realtime Replication

In your Supabase dashboard:

1. Go to **Database** → **Replication**
2. Enable replication for these tables:
   - ✅ `kiosk_devices` (new)
   - ✅ `members`
   - ✅ `calendars`
   - ✅ `events`
   - ✅ `chores`
   - ✅ `lists`
   - ✅ `list_items`
   - ✅ `meals`
   - ✅ `notifications`
   - ✅ `notification_states`
   - ✅ `photos`
   - ✅ `households`

## Step 2: Environment Variables

### Required Variables

Set these in your deployment platform (Vercel Settings → Environment Variables):

```bash
# Supabase Configuration (REQUIRED)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here

# Kiosk Mode (REQUIRED)
REACT_APP_KIOSK_MODE=true

# Auto Sign-In (RECOMMENDED for kiosk)
REACT_APP_KIOSK_AUTO_SIGNIN=true
REACT_APP_KIOSK_ADMIN_EMAIL=admin@household.com
REACT_APP_KIOSK_ADMIN_PASSWORD=secure-password-here

# Hide Sign Out Button (default: true)
REACT_APP_KIOSK_HIDE_SIGNOUT=true
```

### Getting Supabase Credentials

1. Open your Supabase dashboard
2. Go to **Project Settings** → **API**
3. Copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon public key** → `VITE_SUPABASE_ANON_KEY`

## Step 3: Deploy to Vercel

### Option A: Deploy via GitHub (Recommended)

1. Push your code to GitHub
2. Connect repo to Vercel:
   - Visit https://vercel.com/new
   - Import your repository
   - Select `lincon07/lumora_kiosk` project
3. Add environment variables in Vercel:
   - Go to **Settings** → **Environment Variables**
   - Add all variables from Step 2
4. Deploy: `git push` to trigger automatic deployment

### Option B: Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Login
vercel login

# Deploy
vercel --prod

# Set environment variables when prompted, or add them in dashboard afterward
```

### Option C: Run Locally

```bash
# Create environment file
cat > .env.local << EOF
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
REACT_APP_KIOSK_MODE=true
REACT_APP_KIOSK_AUTO_SIGNIN=true
REACT_APP_KIOSK_ADMIN_EMAIL=admin@household.com
REACT_APP_KIOSK_ADMIN_PASSWORD=password
REACT_APP_KIOSK_HIDE_SIGNOUT=true
EOF

# Start dev server
npm run dev
```

## Step 4: Verify Kiosk Status Tracking

Once deployed and running, verify the kiosk is publishing status:

### In Supabase SQL Editor

```sql
-- Check if kiosk is reporting status
SELECT 
  device_name,
  wifi_signal,
  ping_latency_ms,
  battery_percent,
  is_online,
  last_heartbeat,
  NOW() - last_heartbeat as seconds_since_update
FROM kiosk_devices
ORDER BY last_heartbeat DESC;

-- Status should update every ~30 seconds
-- If last_heartbeat is > 60s old, check browser console for errors
```

### In iOS App

The iOS app automatically receives kiosk status via realtime subscriptions:

```typescript
import { useStore } from '@/lib/store'

export function KioskStatusWidget() {
  const { kioskDevices } = useStore()
  const kiosk = kioskDevices[0]

  return (
    <div>
      <p>WiFi: {kiosk?.wifi_signal} dBm</p>
      <p>Ping: {kiosk?.ping_latency_ms}ms</p>
      <p>Battery: {kiosk?.battery_percent}%</p>
      <p>Online: {kiosk?.is_online ? '✓' : '✗'}</p>
      <p>Last seen: {new Date(kiosk?.last_heartbeat).toLocaleTimeString()}</p>
    </div>
  )
}
```

## Step 5: Security Best Practices

### Credential Management

- ✅ **Use Vercel Secrets**: Never commit `.env.local` to git
- ✅ **Rotate Passwords**: Change kiosk admin password regularly
- ✅ **Dedicated Account**: Use a separate admin account for kiosk (not personal)
- ✅ **Restrict Physical Access**: Kiosk should be in secure location

### Supabase RLS Policies

`kiosk_devices` is protected by RLS:
- Only household members can view their kiosk status
- Only authenticated users in the household can update status
- No cross-household data leakage

### Environment Variables

**NEVER** commit these to git:
```bash
# ❌ DON'T do this
git add .env.local
git commit -m "add secrets"

# ✅ DO this instead
# Add to .gitignore (already done)
# Add to Vercel dashboard Settings → Environment Variables
```

## Troubleshooting

### Kiosk Won't Auto-Sign In

```bash
# Check 1: Verify environment variables
# In browser console:
console.log(import.meta.env.REACT_APP_KIOSK_AUTO_SIGNIN)
console.log(import.meta.env.REACT_APP_KIOSK_ADMIN_EMAIL)

# Check 2: Verify Supabase connection
# In browser console:
import { supabase } from './lib/supabase'
console.log(supabase)

# Check 3: Test credentials manually
await api.signIn({
  email: 'admin@example.com',
  password: 'password'
})
```

### Kiosk Status Not Updating

```sql
-- Check if table exists
SELECT * FROM kiosk_devices LIMIT 1;

-- Check if RLS is blocking writes
-- (Try with service_role key in SQL editor)

-- Check if data is old
SELECT 
  NOW() - last_heartbeat as age
FROM kiosk_devices;
```

### iOS App Can't See Kiosk

```bash
# Verify:
# 1. Both apps use same Supabase project
# 2. Both authenticated to same household
# 3. Realtime replication enabled for kiosk_devices
# 4. Check browser/app console for errors
```

## Configuration Options

### Disable Auto Sign-In

```bash
REACT_APP_KIOSK_AUTO_SIGNIN=false
# Leave email/password blank
```

### Show Sign Out Button

```bash
REACT_APP_KIOSK_HIDE_SIGNOUT=false
```

### Disable Kiosk Mode

```bash
REACT_APP_KIOSK_MODE=false
```

## What Changed from iOS App

### UI/Layout
- Navigation: **Bottom tabs → Left side navigation**
- Layout: **Mobile optimized → Full desktop with side nav**
- Screen: **No iOS safe-area padding, proper desktop responsiveness**

### iOS Features Removed
- iOS blur effects (`ios-blur` class)
- Safe-area insets (`pt-safe`, `pb-safe`)
- iOS haptic feedback (Tauri vibrations)
- Active scale animations (`active:scale-95`)

### Features Added
- Automatic kiosk status publishing
- Realtime subscriptions for all data
- Supabase integration
- Device metrics (WiFi, ping, battery)

## Next Steps

1. ✅ Apply `kiosk_devices` migration
2. ✅ Enable realtime replication for all tables
3. ✅ Set environment variables in Vercel
4. ✅ Deploy to Vercel
5. ✅ Verify kiosk status appears in Supabase
6. ✅ Test iOS app can see kiosk status

## Support

- **Supabase Docs**: https://supabase.com/docs
- **GitHub Issues**: https://github.com/lincon07/lumora_kiosk/issues
- **Local Testing**: `npm run dev` for development server

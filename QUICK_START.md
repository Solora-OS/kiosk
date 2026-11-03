# Solora Kiosk - Quick Start Guide

Get your kiosk up and running in 10 minutes.

## 1. Apply Database Migration (2 min)

Go to your Supabase dashboard → SQL Editor and run:

```bash
# Or in Supabase CLI:
supabase db push
```

## 2. Set Environment Variables (3 min)

In Vercel (or your deployment platform):

**Settings** → **Environment Variables** → Add these:

```
VITE_SUPABASE_URL=https://supabase-pink-yacht.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
REACT_APP_KIOSK_MODE=true
REACT_APP_KIOSK_AUTO_SIGNIN=true
REACT_APP_KIOSK_ADMIN_EMAIL=admin@household.com
REACT_APP_KIOSK_ADMIN_PASSWORD=<secure-password>
REACT_APP_KIOSK_HIDE_SIGNOUT=true
```

Get credentials from Supabase: **Project Settings** → **API**

## 3. Deploy (2 min)

```bash
git push origin main
```

Vercel auto-deploys. Check: https://vercel.com/dashboard

## 4. Verify (3 min)

### In Supabase SQL Editor:
```sql
SELECT * FROM kiosk_devices;
```

Should show one row that updates every ~30 seconds.

### In iOS App:
```typescript
const { kioskDevices } = useStore()
console.log(kioskDevices[0])  // Should show WiFi, ping, battery
```

## That's It! 🎉

Your kiosk is now:
- ✅ Automatically signed in as admin
- ✅ Publishing WiFi/ping/battery status every 30s
- ✅ Syncing all data in realtime with iOS app
- ✅ Displaying family hub on a large screen

## Troubleshooting

**Kiosk won't auto-login?**
- Check environment variables are set in Vercel
- Verify email/password are correct
- Check browser console for errors

**Status not updating?**
- Verify `kiosk_devices` migration was applied
- Check Supabase Realtime is enabled for the table
- Look at browser console for API errors

**iOS app can't see kiosk?**
- Both apps must use same Supabase project
- Both must be in same household
- Check Network tab in iOS app developer tools

## Next Steps

- Read [KIOSK_SETUP.md](./KIOSK_SETUP.md) for detailed setup
- Read [SUPABASE_INTEGRATION.md](./SUPABASE_INTEGRATION.md) for architecture
- Customize the kiosk UI in settings
- Set up automatic device restart schedules

## Links

- [Supabase Dashboard](https://app.supabase.com)
- [Vercel Dashboard](https://vercel.com/dashboard)
- [Project Repo](https://github.com/lincon07/lumora_kiosk)

/**
 * widget-env.ts — the few things the home widgets get differently on the wall
 * and on a phone. widgets.tsx is kept identical in kiosk/ and mobile/; each
 * app has its own copy of this file.
 */

import type { Photo } from "@/lib/data"
import { useDisplayPrefs } from "@/lib/display-prefs"
import { useAuthenticatedSrc } from "@/hooks/use-authenticated-src"

/** The wall's own 24-hour clock setting (Settings › Display). */
export function useClock24(): boolean {
  return useDisplayPrefs().clock24
}

/** A loadable URL for a photo, read with the wall's device token. */
export function usePhotoUrl(photo: Photo | null): string | null {
  return useAuthenticatedSrc(photo?.src)
}

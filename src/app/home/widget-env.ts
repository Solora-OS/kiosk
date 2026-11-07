/**
 * widget-env.ts — the few things the home widgets read from the wall's own
 * settings rather than from the household data.
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

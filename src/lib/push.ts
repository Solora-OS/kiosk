/**
 * Notification helper built on the Tauri v2 notification plugin.
 *
 * In a packaged Tauri build (desktop or iOS) this uses the native
 * `@tauri-apps/plugin-notification` APIs. When running in a plain browser
 * preview (Vite dev server, where the Tauri runtime is absent) it falls
 * back to the Web Notification API so the request -> granted -> deliver
 * flow can still be exercised.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"

export type PushPermission = "default" | "granted" | "denied" | "unsupported"

/** True when running inside the Tauri runtime (native webview). */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export function isPushSupported(): boolean {
  if (isTauri()) return true
  return typeof window !== "undefined" && "Notification" in window
}

export async function getPushPermission(): Promise<PushPermission> {
  if (isTauri()) {
    try {
      return (await isPermissionGranted()) ? "granted" : "default"
    } catch {
      return "unsupported"
    }
  }
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  return Notification.permission as PushPermission
}

export async function requestPushPermission(): Promise<PushPermission> {
  if (isTauri()) {
    try {
      let granted = await isPermissionGranted()
      if (!granted) {
        const permission = await requestPermission()
        granted = permission === "granted"
      }
      return granted ? "granted" : "denied"
    } catch {
      return "unsupported"
    }
  }
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  try {
    return (await Notification.requestPermission()) as PushPermission
  } catch {
    return Notification.permission as PushPermission
  }
}

/**
 * Deliver a single OS notification. Uses the native Tauri plugin when running
 * in the packaged app, and the Web Notification API in browser preview. Only
 * delivers when permission is already granted (it won't prompt) so it's safe
 * to call from background polling. Returns whether a notification was shown.
 */
export async function notify(title: string, body: string): Promise<boolean> {
  // Native Tauri path — matches the plugin's documented usage.
  if (isTauri()) {
    try {
      if (!(await isPermissionGranted())) return false
      sendNotification({ title, body })
      return true
    } catch {
      return false
    }
  }

  // Browser preview fallback.
  if (typeof window === "undefined" || !("Notification" in window)) return false
  if (Notification.permission !== "granted") return false
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.()
    if (reg && "showNotification" in reg) {
      await reg.showNotification(title, { body, icon: "/icon.png", badge: "/icon.png" })
      return true
    }
    new Notification(title, { body, icon: "/icon.png" })
    return true
  } catch {
    return false
  }
}

type TestOptions = {
  title?: string
  body?: string
}

export async function sendTestNotification(opts: TestOptions = {}): Promise<boolean> {
  const title = opts.title ?? "Solora Hub"
  const body = opts.body ?? "This is a test notification. Push is working!"

  // Ensure permission first (this path is user-initiated, so prompting is fine).
  const permission = await requestPushPermission()
  if (permission !== "granted") return false
  return notify(title, body)
}

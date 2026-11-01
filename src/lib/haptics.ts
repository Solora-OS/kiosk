// Lightweight haptic helpers. Prefer the native Tauri plugin, fall back to the
// Web Vibration API, and silently no-op everywhere else.
type HapticsModule = typeof import("@tauri-apps/plugin-haptics")

let loader: Promise<HapticsModule | null> | null = null
const load = () => (loader ??= import("@tauri-apps/plugin-haptics").catch(() => null))

const vibrate = (ms: number) => {
  try {
    navigator.vibrate?.(ms)
  } catch {
    // Vibration not supported
  }
}

/** Subtle tick, e.g. crossing a swipe threshold. */
export async function hapticSelection() {
  const mod = await load()
  try {
    if (mod) return void (await mod.selectionFeedback())
  } catch {
    // Plugin not registered on this build
  }
  vibrate(8)
}

/** Firmer bump, e.g. a long-press opening a menu. */
export async function hapticImpact(style: "light" | "medium" | "heavy" = "medium") {
  const mod = await load()
  try {
    if (mod) return void (await mod.impactFeedback(style))
  } catch {
    // Plugin not registered on this build
  }
  vibrate(style === "heavy" ? 25 : style === "medium" ? 15 : 10)
}

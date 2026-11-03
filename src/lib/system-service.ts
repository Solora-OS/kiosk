"use client"

/**
 * System service — the OS-level controls Solora owns instead of the desktop:
 * output volume, screen brightness, display sleep and power.
 *
 * Backed by Tauri commands in `src-tauri/src/lib.rs`:
 *   system_volume_get / system_volume_set / system_mute_set   (wpctl → amixer)
 *   system_brightness_get / system_brightness_set             (brightnessctl → /sys/class/backlight)
 *   system_display_sleep                                       (xset dpms)
 *   system_power                                               (systemctl poweroff | reboot)
 *
 * In the browser preview every call is mocked so the UI stays exercisable.
 */

import { addLog } from "./hub"

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core")
  return mod.invoke<T>(cmd, args)
}

export type AudioState = { volume: number; muted: boolean }

const mock = { volume: 55, muted: false, brightness: 80 }

export async function getAudio(): Promise<AudioState> {
  if (!isTauri()) return { volume: mock.volume, muted: mock.muted }
  try {
    return await invoke<AudioState>("system_volume_get")
  } catch (err) {
    console.error("[system] volume get failed:", err)
    return { volume: mock.volume, muted: mock.muted }
  }
}

/** 0-100 */
export async function setVolume(volume: number): Promise<void> {
  const v = Math.round(Math.max(0, Math.min(100, volume)))
  mock.volume = v
  if (!isTauri()) return
  await invoke("system_volume_set", { volume: v }).catch((err) => console.error("[system] volume set failed:", err))
}

export async function setMuted(muted: boolean): Promise<void> {
  mock.muted = muted
  if (!isTauri()) return
  await invoke("system_mute_set", { muted }).catch((err) => console.error("[system] mute failed:", err))
}

/** 0-100, or null when the panel has no software-controllable backlight. */
export async function getBrightness(): Promise<number | null> {
  if (!isTauri()) return mock.brightness
  try {
    return await invoke<number | null>("system_brightness_get")
  } catch {
    return null
  }
}

export async function setBrightness(level: number): Promise<void> {
  const v = Math.round(Math.max(5, Math.min(100, level)))
  mock.brightness = v
  if (!isTauri()) return
  await invoke("system_brightness_set", { level: v }).catch((err) => console.error("[system] brightness failed:", err))
}

/**
 * Turn the panel off via DPMS. Touch wakes it again on most panels; the UI
 * also shows its own black "asleep" layer so the result is the same either way.
 */
export async function sleepDisplay(): Promise<void> {
  addLog("info", "system", "Display put to sleep")
  if (!isTauri()) return
  await invoke("system_display_sleep").catch(() => {})
}

/** Turn the panel back on after sleepDisplay(). */
export async function wakeDisplay(): Promise<void> {
  if (!isTauri()) return
  await invoke("system_display_wake").catch(() => {})
}

export type PowerAction = "poweroff" | "reboot"

export async function power(action: PowerAction): Promise<void> {
  addLog("warning", "system", action === "poweroff" ? "Shutting down" : "Rebooting device")
  if (!isTauri()) {
    console.info(`[system] (preview) would ${action}`)
    return
  }
  await invoke("system_power", { action })
}

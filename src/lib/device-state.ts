"use client"

/**
 * Local device-state persistence.
 *
 * The kiosk keeps a small JSON state object describing how this physical
 * device has been set up:
 *
 *   { setupComplete, language, timezone, deviceName }
 *
 * This is the device's own source of truth for the *startup flow* (splash →
 * register → setup → pair → home). It is mirrored to Supabase via the
 * `kiosk_save_setup` RPC, but the local copy lets the appliance boot instantly
 * and decide what screen to show before the network is even available.
 *
 * Persistence strategy (per product decision):
 *   1. Tauri Store plugin (`@tauri-apps/plugin-store`) — writes a JSON file in
 *      the app data dir on a real device. Survives webview storage clears.
 *   2. localStorage fallback — used in the browser/dev where Tauri isn't
 *      present, and as a safety net if the native store fails to load.
 *
 * Both layers are written on every save so the two never drift; reads prefer
 * the native store and fall back to localStorage.
 */

export type DeviceState = {
  /** True once the setup wizard (language, wifi, timezone, name) has finished. */
  setupComplete: boolean
  /** BCP-47 language tag, e.g. "en-US". */
  language: string | null
  /** IANA timezone, e.g. "America/Los_Angeles". */
  timezone: string | null
  /** Human-friendly device name shown in the household, e.g. "Kitchen Hub". */
  deviceName: string | null
  /** xrandr rotation applied on boot: "normal" | "left" | "right" | "inverted". */
  orientation: string | null
  /** Minutes of inactivity before the photo slideshow starts. Null = disabled. */
  slideshowIdleMins: number | null
}

export const DEFAULT_DEVICE_STATE: DeviceState = {
  setupComplete: false,
  language: null,
  timezone: null,
  deviceName: null,
  orientation: null,
  slideshowIdleMins: 5,
}

const STORE_FILE = "device-state.json"
const STORE_KEY = "state"
const LS_KEY = "solora.kiosk.deviceState"

/** True when running inside the Tauri native shell. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// Lazily-loaded native store handle. Kept as a promise so concurrent callers
// share a single load.
type TauriStore = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  save(): Promise<void>
}
let _storePromise: Promise<TauriStore | null> | null = null

async function getNativeStore(): Promise<TauriStore | null> {
  if (!isTauri()) return null
  if (_storePromise) return _storePromise
  _storePromise = (async () => {
    try {
      const mod = await import("@tauri-apps/plugin-store")
      // load() opens (or creates) the store file in the app data dir.
      return (await mod.load(STORE_FILE, {
        autoSave: true,
        defaults: { [STORE_KEY]: DEFAULT_DEVICE_STATE },
      })) as unknown as TauriStore
    } catch (err) {
      console.error("[v0] device-state: native store unavailable, using localStorage:", err)
      return null
    }
  })()
  return _storePromise
}

function readLocalStorage(): DeviceState | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return normalize(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeLocalStorage(state: DeviceState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable */
  }
}

/** Coerce an arbitrary parsed object into a complete, well-typed DeviceState. */
function normalize(value: unknown): DeviceState {
  const v = (value ?? {}) as Partial<DeviceState>
  return {
    setupComplete: !!v.setupComplete,
    language: v.language ?? null,
    timezone: v.timezone ?? null,
    deviceName: v.deviceName ?? null,
    orientation: v.orientation ?? null,
    slideshowIdleMins: typeof v.slideshowIdleMins === "number" ? v.slideshowIdleMins : 5,
  }
}

/** Load the persisted device state, preferring the native store. */
export async function loadDeviceState(): Promise<DeviceState> {
  const store = await getNativeStore()
  if (store) {
    try {
      const fromStore = await store.get<DeviceState>(STORE_KEY)
      if (fromStore) return normalize(fromStore)
      // Native store empty — migrate any legacy localStorage value into it.
      const legacy = readLocalStorage()
      if (legacy) {
        await store.set(STORE_KEY, legacy)
        await store.save()
        return legacy
      }
      return { ...DEFAULT_DEVICE_STATE }
    } catch (err) {
      console.error("[v0] device-state: native read failed, falling back:", err)
    }
  }
  return readLocalStorage() ?? { ...DEFAULT_DEVICE_STATE }
}

/** Persist a full device state object to both layers. */
export async function saveDeviceState(state: DeviceState): Promise<void> {
  const normalized = normalize(state)
  // Always write localStorage so the two layers stay in sync.
  writeLocalStorage(normalized)
  const store = await getNativeStore()
  if (store) {
    try {
      await store.set(STORE_KEY, normalized)
      await store.save()
    } catch (err) {
      console.error("[v0] device-state: native write failed:", err)
    }
  }
}

/** Merge a partial update into the persisted state and return the result. */
export async function patchDeviceState(patch: Partial<DeviceState>): Promise<DeviceState> {
  const current = await loadDeviceState()
  const next = normalize({ ...current, ...patch })
  await saveDeviceState(next)
  return next
}

/** Wipe local device state (used when the device is reset/unenrolled). */
export async function clearDeviceState(): Promise<void> {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* noop */
  }
  const store = await getNativeStore()
  if (store) {
    try {
      await store.set(STORE_KEY, DEFAULT_DEVICE_STATE)
      await store.save()
    } catch {
      /* noop */
    }
  }
}

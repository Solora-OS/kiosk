// ---------------------------------------------------------------------------
// Where the household hub is.
//
// Inside the app (Android panel, Linux, macOS) the hub runs in the app itself
// (src-tauri/src/hub.rs) on port 4000, so it's always http://localhost:4000,
// whatever .env says: a LAN address left in .env can't leak into a build.
// In a plain browser (vite dev) VITE_SOLORA_SERVER_URL can point at another
// hub, e.g. "http://192.168.1.10:4000"; it defaults to localhost too.
// ---------------------------------------------------------------------------

const IN_APP_HUB = "http://localhost:4000"

function insideApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export const LOCAL_API_BASE: string = insideApp()
  ? IN_APP_HUB
  : ((import.meta.env.VITE_SOLORA_SERVER_URL as string | undefined)?.replace(/\/$/, "") || IN_APP_HUB)

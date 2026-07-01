/**
 * Kiosk mode configuration
 *
 * When running as a kiosk/hub, the app can be configured to:
 * - Skip the login screen and auto-sign in via the local hub server
 * - Prevent sign-out functionality
 * - Hide admin-level controls
 *
 * SECURITY: Admin credentials are never bundled into the frontend.
 * Auto sign-in is handled by the local hub server (POST /api/v1/auth/kiosk-autologin),
 * which reads credentials from a secure file on the hub machine.
 */

export const kioskConfig = {
  // Enable kiosk mode. This repo IS the wall-display kiosk, so pairing mode is on
  // by default; set VITE_KIOSK_MODE="false" to run the legacy auth app shell.
  enabled: import.meta.env.VITE_KIOSK_MODE !== "false",

  // Whether to attempt auto sign-in on startup via the local hub server.
  // The server reads credentials from ~/.lumora/kiosk-autologin.json (never the frontend).
  autoSignIn: import.meta.env.VITE_KIOSK_AUTO_SIGNIN === "true",

  // Whether to hide the sign-out button
  hideSignOut: import.meta.env.VITE_KIOSK_HIDE_SIGNOUT !== "false",
}

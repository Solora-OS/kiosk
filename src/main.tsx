import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./components/theme-provider";
import { SeasonProvider } from "./components/season-provider";
import { SeasonEffects } from "./components/season/effects";
import { ControlCenter, SleepLayer } from "./components/os/control-center";
import { TouchKeyboard } from "./components/os/touch-keyboard";
import { DisplayRemote } from "./components/os/display-remote";
import { Toaster } from "./components/ui/sonner";
import { UpdateDialog } from "./components/ui/reusables/update-dialog";
import { ErrorBoundary } from "./components/os/error-state";
import { applyDisplayPrefs } from "./lib/display-prefs"
import { isHubDevice, startUpdatePolling } from "./lib/hub"

// Text size and the like, before the first paint.
applyDisplayPrefs()

// Hourly, from first boot: a display gets updates whether or not anyone opens
// Settings, and before it's claimed (central's ota:push only reaches claimed ones).
if (isHubDevice()) startUpdatePolling()

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <SeasonProvider>
        <ErrorBoundary variant="screen">
          <App />
        </ErrorBoundary>
        {/* OS layer — lives above every screen, from first boot to the home dashboard */}
        <SeasonEffects />
        <ControlCenter />
        <SleepLayer />
        {/* Trusted phones can change brightness, theme, season… on this display */}
        <DisplayRemote />
        {/* On-screen keyboard — the kiosk has no OS keyboard */}
        <TouchKeyboard />
        {/* Global Sonner toaster — receives toast() calls from anywhere in the app */}
        <Toaster position="bottom-right" offset={24} gap={12} visibleToasts={3} />
        {/* Global update dialog — auto-opens when checkForUpdates() finds a new version */}
        <UpdateDialog />
      </SeasonProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

// Fade out the boot frame from index.html once React's first screen has painted.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const boot = document.getElementById("boot")
  if (!boot) return
  boot.classList.add("boot-ready", "boot-done")
  document.documentElement.classList.remove("boot-see-through")
  setTimeout(() => boot.remove(), 600)
}))

#!/usr/bin/env bash
# Runs on your Mac. Builds the debug Android kiosk and installs it on the
# connected emulator/panel. The household hub runs inside the app (src/hub.rs,
# port 4000 on the device), so nothing needs to run on this Mac.
#   ./scripts/android-dev.sh            # build + install
#   ./scripts/android-dev.sh --no-build # just reinstall the last build
#
# The web view's CSP only lets the app talk to localhost and https: the wall
# reaches its in-app hub on localhost:4000 (src/lib/hub-address.ts) and central
# over HTTPS. These override kiosk/.env for this build only. SOLORA_HUB_CENTRAL_URL is the
# central the in-app hub registers with (default: the same one).
set -euo pipefail
KIOSK="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
APK="$KIOSK/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"

export VITE_CENTRAL_API_URL="${VITE_CENTRAL_API_URL:-https://dev-api.solara-calendar.tech}"
export VITE_CENTRAL_SOCKET_URL="${VITE_CENTRAL_SOCKET_URL:-https://dev-api.solara-calendar.tech}"
export SOLORA_HUB_CENTRAL_URL="${SOLORA_HUB_CENTRAL_URL:-$VITE_CENTRAL_API_URL}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home)}"
export ANDROID_HOME="$SDK"
export NDK_HOME="${NDK_HOME:-$(ls -d "$SDK"/ndk/* | sort -V | tail -1)}"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> build (hub in-app on localhost:4000, central $VITE_CENTRAL_API_URL, hub central $SOLORA_HUB_CENTRAL_URL)"
  (cd "$KIOSK" && npx tauri android build --debug --target aarch64 --apk)
fi

echo "==> install"
"$ADB" wait-for-device
"$ADB" install -r "$APK" | tail -1
# Earlier builds forwarded the device's port 4000 to a hub on this Mac; that
# would now sit on the in-app hub's port.
"$ADB" reverse --remove tcp:4000 >/dev/null 2>&1 || true
echo "==> the wall's hub runs in the app (device port 4000)"

#!/usr/bin/env bash
# Runs on your Mac. Builds the Android wall-display APK, signs it twice and
# hands it to central as a draft release:
#   1. Android signing (gen/android/keystore.properties → ~/solora-kiosk-release.jks).
#      Every release must use that same key or panels refuse the update.
#   2. Solora update signing (the minisign key behind plugins.updater.pubkey);
#      src-tauri/src/apk_update.rs checks this before installing.
# Then uploads the APK to a GitHub release and creates the central release
# (a draft — advance it from the console's Releases page).
#
#   TAURI_SIGNING_PRIVATE_KEY_PATH=~/kiosk-updater.key \
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... ./scripts/release-android.sh
#
# Env:
#   TAURI_SIGNING_PRIVATE_KEY(_PATH), TAURI_SIGNING_PRIVATE_KEY_PASSWORD   required
#   ADMIN_API_KEY      create the central release directly; without it the
#                      script writes latest-android.json to paste under New release
#   CENTRAL_API_URL    default https://api.solara-calendar.tech
#   RELEASE_REPO       GitHub repo for the APK, default Solora-OS/kiosk
#   NOTES              release notes
# Flags:
#   --no-publish       build and sign only
#   --no-updater-sig   Android signing only, for provisioning panels over USB
#                      (os/android/provision-panel.sh); not publishable, since
#                      panels only take updates carrying the updater signature
set -euo pipefail

KIOSK="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID="$KIOSK/src-tauri/gen/android"
CENTRAL_API_URL="${CENTRAL_API_URL:-https://api.solara-calendar.tech}"
RELEASE_REPO="${RELEASE_REPO:-Solora-OS/kiosk}"
PUBLISH=1 UPDATER_SIG=1
[[ "${1:-}" == "--no-publish" ]] && PUBLISH=0
[[ "${1:-}" == "--no-updater-sig" ]] && PUBLISH=0 UPDATER_SIG=0

die() { echo "error: $*" >&2; exit 1; }

# The web view only reaches central over HTTPS (tauri.conf.json CSP; release
# builds also refuse cleartext), so don't take kiosk/.env's dev addresses.
export VITE_CENTRAL_API_URL="${VITE_CENTRAL_API_URL:-$CENTRAL_API_URL}"
export VITE_CENTRAL_SOCKET_URL="${VITE_CENTRAL_SOCKET_URL:-$CENTRAL_API_URL}"
export SOLORA_HUB_CENTRAL_URL="${SOLORA_HUB_CENTRAL_URL:-$CENTRAL_API_URL}"
[[ "$VITE_CENTRAL_API_URL$VITE_CENTRAL_SOCKET_URL$SOLORA_HUB_CENTRAL_URL" != *http:* ]] || die "central must be https:// in a release build"

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"

[[ -f "$ANDROID/keystore.properties" ]] || die "no $ANDROID/keystore.properties — release builds would be unsigned"
(( ! UPDATER_SIG )) || [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]] \
  || die "set TAURI_SIGNING_PRIVATE_KEY_PATH (the key for plugins.updater.pubkey in tauri.conf.json)"

VERSION="$(node -p "require('$KIOSK/src-tauri/tauri.conf.json').version")"
ASSET="solora-kiosk-$VERSION-android-aarch64.apk"
OUT="$KIOSK/release/android/$VERSION"
mkdir -p "$OUT"
echo "==> Solora kiosk v$VERSION (android-aarch64)"

echo "==> build"
(cd "$KIOSK" && npx tauri android build --target aarch64 --apk)
APK="$(ls -t "$ANDROID"/app/build/outputs/apk/*/release/*.apk | head -1)"
[[ -f "$APK" ]] || die "no release APK was built"
cp "$APK" "$OUT/$ASSET"

echo "==> check Android signature"
KS_FILE="$(grep '^storeFile=' "$ANDROID/keystore.properties" | cut -d= -f2-)"
KS_PASS="$(grep '^password=' "$ANDROID/keystore.properties" | cut -d= -f2-)"
KS_ALIAS="$(grep '^keyAlias=' "$ANDROID/keystore.properties" | cut -d= -f2-)"
WANT="$("$JAVA_HOME/bin/keytool" -exportcert -keystore "$KS_FILE" -alias "$KS_ALIAS" -storepass "$KS_PASS" | shasum -a 256 | cut -d' ' -f1)"
GOT="$("$BUILD_TOOLS/apksigner" verify --print-certs "$OUT/$ASSET" | grep -m1 'SHA-256 digest' | awk '{print $NF}')"
[[ "$WANT" == "$GOT" ]] || die "APK is not signed with $KS_FILE (got ${GOT:-nothing})"

if (( ! UPDATER_SIG )); then
  echo "==> done (--no-updater-sig): $OUT/$ASSET"
  exit 0
fi

echo "==> sign for the Solora updater"
rm -f "$OUT/$ASSET.sig"
(cd "$KIOSK" && npx tauri signer sign "$OUT/$ASSET" >/dev/null)
SIG="$(cat "$OUT/$ASSET.sig")"

URL="https://github.com/$RELEASE_REPO/releases/download/v$VERSION/$ASSET"
node -e '
  const [version, url, signature, notes] = process.argv.slice(1)
  const body = { version, notes, platforms: { "android-aarch64": { url, signature } } }
  require("fs").writeFileSync(process.argv[5], JSON.stringify(body, null, 2) + "\n")
' "$VERSION" "$URL" "$SIG" "${NOTES:-}" "$OUT/latest-android.json"
echo "    $OUT/$ASSET"

if [[ $PUBLISH == 0 ]]; then
  echo "==> done (--no-publish): $OUT"
  exit 0
fi

echo "==> upload to github.com/$RELEASE_REPO (v$VERSION)"
gh release view "v$VERSION" --repo "$RELEASE_REPO" >/dev/null 2>&1 \
  || gh release create "v$VERSION" --repo "$RELEASE_REPO" --title "v$VERSION" --notes "${NOTES:-}" >/dev/null
gh release upload "v$VERSION" "$OUT/$ASSET" --repo "$RELEASE_REPO" --clobber

if [[ -z "${ADMIN_API_KEY:-}" ]]; then
  echo "==> done. In the console: Releases → New release, paste $OUT/latest-android.json"
  exit 0
fi

echo "==> create central release (draft)"
STATUS="$(curl -sS -o "$OUT/central-response.json" -w '%{http_code}' -X POST "$CENTRAL_API_URL/admin/releases" \
  -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" --data @"$OUT/latest-android.json")"
[[ "$STATUS" == 201 ]] || die "central answered $STATUS: $(cat "$OUT/central-response.json")"
echo "==> done. v$VERSION is a draft in central — advance it from the console's Releases page"

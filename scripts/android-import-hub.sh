#!/usr/bin/env bash
# Runs on your Mac. Copies an existing hub's data folder (the Node hub's
# ~/.solora, or another Rust hub's) into the kiosk app on the connected
# emulator/panel, so that hub's family, phones' sign-ins and central link carry
# on there. Debug builds only (it uses run-as); a release panel takes a family
# over with a transfer code from the old hub instead (routes/transfer.rs).
#   ./scripts/android-import-hub.sh            # this Mac's ~/.solora
#   ./scripts/android-import-hub.sh path/to/.solora
#
# Refuses if the app's hub already has a family. Its old data is kept in the
# app as hub-before-import-<time>.
set -euo pipefail
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
PKG=com.solora.kiosk
SRC="${1:-$HOME/.solora}"
STAGE=/data/local/tmp/solora-import-hub

# lumora.db is a hub from before the rename; the app renames it on start.
[[ -f "$SRC/solora.db" || -f "$SRC/lumora.db" ]] || { echo "no solora.db in $SRC"; exit 1; }
"$ADB" wait-for-device

echo "==> is the app's hub still unclaimed?"
"$ADB" forward tcp:4799 tcp:4000 >/dev/null
info="$(curl -s --max-time 5 http://127.0.0.1:4799/api/v1/hub/info || true)"
"$ADB" forward --remove tcp:4799 >/dev/null 2>&1 || true
if [[ "$info" == *'"claimed":true'* ]]; then
  echo "the app's hub already has a family; move it with a transfer code instead"
  exit 1
fi

echo "==> copy $SRC to the device"
# A copy taken while a hub is writing can miss the newest rows: stop that hub first.
"$ADB" shell rm -rf "$STAGE"
"$ADB" push "$SRC" "$STAGE" >/dev/null
"$ADB" shell chmod -R a+rX "$STAGE"

echo "==> swap it in"
"$ADB" shell run-as "$PKG" sh -c "'rm -rf hub-import && cp -r $STAGE hub-import'"
"$ADB" shell rm -rf "$STAGE"
# `am force-stop` doesn't stop Solora (device owner, home screen), so swap with
# two renames and kill the app as itself in the same step; Android starts it
# again straight away, on the new data. Anything the old process still writes
# lands in the folder set aside.
pid="$("$ADB" shell pidof "$PKG" || true)"
"$ADB" shell run-as "$PKG" sh -c "'[ -d hub ] && mv hub hub-before-import-\$(date +%s); mv hub-import hub; [ -n \"$pid\" ] && kill $pid'"

echo "==> restart"
sleep 2
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 6
"$ADB" forward tcp:4799 tcp:4000 >/dev/null
curl -s --max-time 5 http://127.0.0.1:4799/api/v1/hub/info; echo
"$ADB" forward --remove tcp:4799 >/dev/null 2>&1 || true

#!/usr/bin/env bash
# install.sh — install and enable the lumora-server systemd service.
#
# Usage:
#   cd server/
#   bash scripts/install.sh
#
# What it does:
#   1. Builds the TypeScript source (npm run build)
#   2. Copies the compiled output to /opt/lumora/server
#   3. Installs the systemd unit as lumora-server@<USER>.service
#   4. Enables and starts the service
#
# Run as your normal (non-root) user — the script uses sudo only where needed.

set -euo pipefail

# The kiosk app runs the hub itself now (README.md); this service would take
# the same port 4000 and the same ~/.lumora.
if [[ "${SOLORA_NODE_HUB:-}" != "1" ]]; then
  echo "The hub runs inside the kiosk app now; this Node server is reference only." >&2
  echo "Set SOLORA_NODE_HUB=1 to install it anyway (then run the app with SOLORA_HUB=off)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
CURRENT_USER="${SUDO_USER:-$USER}"
INSTALL_DIR="/opt/lumora/server"
SERVICE_NAME="lumora-server@${CURRENT_USER}.service"
UNIT_FILE="${SERVER_DIR}/lumora-server.service"

echo "==> Building lumora-server..."
cd "$SERVER_DIR"
npm install
npm run build

echo "==> Installing to ${INSTALL_DIR}..."
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r dist package.json node_modules "$INSTALL_DIR/"
sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$INSTALL_DIR"

echo "==> Installing systemd unit..."
sudo cp "$UNIT_FILE" /etc/systemd/system/
sudo systemctl daemon-reload

echo "==> Enabling and starting ${SERVICE_NAME}..."
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo ""
echo "Done. Check status with:"
echo "  systemctl status ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "API available at: http://localhost:4000/api/v1"
echo "Health:           http://localhost:4000/health"

#!/usr/bin/env bash
# Runs the app store review hub on the Solora VPS: the Node hub as its own
# service (solora-demo-hub, user solora-demo, data in /srv/solora/demo-home),
# linked to prod central. Only outbound traffic: phones reach it through
# central's relay, and ufw keeps its port closed.
#
#   bash scripts/deploy-demo-hub.sh          update the code, keep the data
#   bash scripts/deploy-demo-hub.sh --seed   first time: also seed the family (prints the reviewer codes)
#   bash scripts/deploy-demo-hub.sh --recode new reviewer codes, family kept (prints them)
#   bash scripts/deploy-demo-hub.sh --shared one open code for closed testers, family kept (prints it)
set -euo pipefail

VPS="${SOLORA_VPS:-root@179.198.195.6}"
CENTRAL="${DEMO_CENTRAL_URL:-https://api.solara-calendar.tech}"
SEED="${1:-}"
cd "$(dirname "$0")/.."

npm run build
ssh "$VPS" "mkdir -p /srv/solora/demo-hub"
rsync -az --delete dist scripts package.json package-lock.json "$VPS:/srv/solora/demo-hub/"

ssh "$VPS" CENTRAL="$CENTRAL" SEED="$SEED" bash -s <<'REMOTE'
set -euo pipefail
id solora-demo >/dev/null 2>&1 || useradd --system --home-dir /srv/solora/demo-home --create-home --shell /usr/sbin/nologin solora-demo
cd /srv/solora/demo-hub
npm ci --omit=dev --no-audit --no-fund >/dev/null
# The hub runs as solora-demo; put back anything another deploy took over.
chown -R solora-demo:solora-demo /srv/solora/demo-home /srv/solora/demo-hub

cat > /etc/systemd/system/solora-demo-hub.service <<UNIT
[Unit]
Description=Solora demo hub (app store review household)
After=network-online.target solora-central.service
Wants=network-online.target

[Service]
User=solora-demo
WorkingDirectory=/srv/solora/demo-hub
Environment=NODE_ENV=production
Environment=HOME=/srv/solora/demo-home
Environment=SOLORA_PORT=4500
Environment=SOLORA_MDNS=off
Environment=CENTRAL_API_URL=$CENTRAL
# Central serves REST and Socket.IO on the same address behind nginx.
Environment=CENTRAL_SOCKET_URL=$CENTRAL
Environment=HUB_NAME=Solora Demo Hub
Environment=HUB_OWNER_EMAIL=solora.support@gmail.com
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

up() { for i in $(seq 1 30); do curl -fs localhost:4500/api/v1/hub/info >/dev/null && return 0; sleep 1; done; journalctl -u solora-demo-hub -n 30 --no-pager; return 1; }

if [ "$SEED" = --seed ]; then
  systemctl start solora-demo-hub && up
  systemctl stop solora-demo-hub
  sudo -u solora-demo HOME=/srv/solora/demo-home node scripts/seed-demo.mjs
elif [ "$SEED" = --recode ]; then
  systemctl stop solora-demo-hub
  sudo -u solora-demo HOME=/srv/solora/demo-home node scripts/seed-demo.mjs --recode
elif [ "$SEED" = --shared ]; then
  # Restart first so the hub adds the invites.shared column.
  systemctl restart solora-demo-hub && up
  systemctl stop solora-demo-hub
  sudo -u solora-demo HOME=/srv/solora/demo-home node scripts/seed-demo.mjs --shared
fi
systemctl enable --now solora-demo-hub >/dev/null 2>&1
systemctl restart solora-demo-hub
up
curl -fs localhost:4500/api/v1/hub/info; echo
REMOTE

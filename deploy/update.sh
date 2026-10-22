#!/usr/bin/env bash
# Brings the server to the latest commit of its branch, rebuilds and restarts the app: sudo bash /opt/talk2urself/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/talk2urself
APP_USER=talk2urself
[ "$(id -u)" = 0 ] || { echo "Rode como root: sudo bash update.sh"; exit 1; }
BRANCH="$(sudo -u "$APP_USER" -H git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"

sudo -u "$APP_USER" -H sh -c "cd '$APP_DIR' && git fetch -q origin '$BRANCH' && git reset -q --hard 'origin/$BRANCH' \
  && npm ci --include=dev --no-audit --no-fund && npm run build"
install -m 644 "$APP_DIR/deploy/talk2urself.service" /etc/systemd/system/talk2urself.service
systemctl daemon-reload
systemctl restart talk2urself
echo "Atualizado para $(sudo -u "$APP_USER" -H git -C "$APP_DIR" log -1 --format='%h %s')"

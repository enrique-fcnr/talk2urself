#!/usr/bin/env bash
# Installs talk2urself on a fresh Ubuntu 24.04 server (AWS Lightsail, 1 GB). Run as root; safe to run again.
#   sudo bash setup.sh                     # address <ip>.sslip.io (HTTPS without a domain of your own)
#   sudo DOMAIN=example.com bash setup.sh  # your domain, once its DNS points to this server
# Steps: swap, Node 22, Caddy, service user, GitHub deploy key, code, settings file, build, services.
set -euo pipefail

REPO="${REPO:-git@github.com:enrique-fcnr/talk2urself.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/talk2urself
APP_USER=talk2urself
ENV_FILE=/etc/talk2urself.env
[ "$(id -u)" = 0 ] || { echo "Rode como root: sudo bash setup.sh"; exit 1; }
step() { printf '\n== %s\n' "$*"; }

step "Memória extra (swap de 2 GB): o build do app não cabe só em 1 GB"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Pacotes do sistema, Node 22 e Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg openssl
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

step "Usuário do serviço e chave de leitura do GitHub"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
HOME_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)"
as_app() { sudo -u "$APP_USER" -H "$@"; }
as_app mkdir -p "$HOME_DIR/.ssh"
[ -f "$HOME_DIR/.ssh/id_ed25519" ] || as_app ssh-keygen -q -t ed25519 -N '' -C talk2urself-server -f "$HOME_DIR/.ssh/id_ed25519"
as_app sh -c "ssh-keyscan -t ed25519 github.com 2>/dev/null > '$HOME_DIR/.ssh/known_hosts'"
if ! as_app git ls-remote "$REPO" >/dev/null 2>&1; then
  echo
  echo "O servidor ainda não pode ler o repositório. Adicione esta chave em GitHub > repositório > Settings > Deploy keys"
  echo "(somente leitura, sem 'Allow write access') e rode este script de novo:"
  echo
  cat "$HOME_DIR/.ssh/id_ed25519.pub"
  exit 2
fi

step "Código ($BRANCH)"
mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" fetch -q origin "$BRANCH"
  as_app git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  as_app git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
as_app mkdir -p "$APP_DIR/.local"

step "Arquivo de configuração ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  # A fresh access code; the keys are filled in afterwards (sudo nano /etc/talk2urself.env).
  {
    echo "# talk2urself: chaves e configurações (somente root e o serviço leem este arquivo)."
    sed -e '/^#/d' -e '/^$/d' "$APP_DIR/.env.example"
    echo "ACCESS_CODE=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
  } > "$ENV_FILE"
fi
grep -q '^ACCESS_CODE=.\{24,\}' "$ENV_FILE" || echo "ACCESS_CODE=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)" >> "$ENV_FILE"
chown root:"$APP_USER" "$ENV_FILE" && chmod 640 "$ENV_FILE"

step "Build do app"
as_app sh -c "cd '$APP_DIR' && npm ci --include=dev --no-audit --no-fund && npm run build"

step "Serviços (app e HTTPS)"
IP_ADDRESS="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]' | tr . -).sslip.io"
DOMAIN="${DOMAIN:-$IP_ADDRESS}"
sed "s/^SITE_ADDRESS {/$DOMAIN {/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
if [ "$DOMAIN" != "$IP_ADDRESS" ]; then
  # With a domain of its own, www and the old sslip.io address lead to it.
  printf '\nwww.%s, %s {\n\tredir https://%s{uri} permanent\n}\n' "$DOMAIN" "$IP_ADDRESS" "$DOMAIN" >> /etc/caddy/Caddyfile
fi
install -m 644 "$APP_DIR/deploy/talk2urself.service" /etc/systemd/system/talk2urself.service
systemctl daemon-reload
systemctl enable -q talk2urself caddy
systemctl restart talk2urself
systemctl reload caddy 2>/dev/null || systemctl restart caddy

step "Pronto"
CODE="$(grep '^ACCESS_CODE=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
echo "Endereço público: https://$DOMAIN"
echo "Seu link de acesso (abra uma vez em cada aparelho e não compartilhe): https://$DOMAIN/?k=$CODE"
grep -q '^OPENAI_API_KEY=.\+' "$ENV_FILE" || echo "Falta preencher as chaves: sudo nano $ENV_FILE  e depois  sudo systemctl restart talk2urself"

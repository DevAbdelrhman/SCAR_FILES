#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo on the Ubuntu server." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  echo "Install Node.js 20 or newer before running this installer." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Install npm before running this installer." >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_APP_DIR="/var/www/scardrone-files"
DATA_DIR="/var/lib/scardrone-files"
ENV_FILE="/etc/scardrone-files.env"
NGINX_AVAILABLE="/etc/nginx/sites-available/scar-files-http.conf"
NGINX_HTTPS_AVAILABLE="/etc/nginx/sites-available/scar-files-https.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/files.scardrone.cc"
SERVICE_FILE="/etc/systemd/system/scar-files.service"

if [[ "$APP_DIR" != "$EXPECTED_APP_DIR" ]]; then
  echo "Place the release in $EXPECTED_APP_DIR before running this installer." >&2
  exit 1
fi
INITIAL_INSTALL=1
if [[ -e "$NGINX_AVAILABLE" || -e "$NGINX_HTTPS_AVAILABLE" || -e "$NGINX_ENABLED" || -e "$SERVICE_FILE" ]]; then
  if [[ -f "$SERVICE_FILE" && -L "$NGINX_ENABLED" ]]; then
    ENABLED_TARGET="$(readlink -f "$NGINX_ENABLED")"
    if [[ ( "$ENABLED_TARGET" == "$NGINX_AVAILABLE" || "$ENABLED_TARGET" == "$NGINX_HTTPS_AVAILABLE" ) && -f "$ENABLED_TARGET" ]]; then
      INITIAL_INSTALL=0
    else
      echo "A Nginx site or service file already exists outside the SCAR FILES setup. Nothing was overwritten." >&2
      exit 1
    fi
  else
    echo "A Nginx site or service file already exists. Nothing was overwritten." >&2
    exit 1
  fi
fi
if [[ "$INITIAL_INSTALL" -eq 1 ]] && grep -RqsE 'server_name[^;]*files\.scardrone\.cc' /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null; then
  echo "An enabled Nginx block already names files.scardrone.cc. Inspect it before installing." >&2
  exit 1
fi

if ! id scarfiles >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin scarfiles
fi
install -d -o scarfiles -g scarfiles -m 0755 "$APP_DIR"
install -d -o scarfiles -g scarfiles -m 0750 "$DATA_DIR"
install -d -o scarfiles -g scarfiles -m 0700 "$DATA_DIR/uploads"
chown -R scarfiles:scarfiles "$APP_DIR"
chmod 0755 "$APP_DIR"

if [[ ! -e "$ENV_FILE" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3080
SESSION_SECRET=$SESSION_SECRET
DATA_DIR=$DATA_DIR
DATABASE_PATH=$DATA_DIR/scar-files.sqlite
SESSION_DATABASE_PATH=$DATA_DIR/sessions.sqlite
STORAGE_DIR=$DATA_DIR/uploads
MAX_UPLOAD_BYTES=1073741824
MAX_UPLOAD_BATCH_BYTES=2147483648
MAX_UPLOAD_FILES=10
MAX_STORAGE_BYTES=107374182400
SESSION_MAX_AGE_MS=28800000
EOF
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

runuser -u scarfiles -- npm ci --include=dev --prefix "$APP_DIR"
runuser -u scarfiles -- npm run build --prefix "$APP_DIR"
runuser -u scarfiles -- npm prune --omit=dev --prefix "$APP_DIR"

if [[ "$INITIAL_INSTALL" -eq 1 ]]; then
  install -m 0644 "$APP_DIR/deploy/scar-files.service" "$SERVICE_FILE"
  install -m 0644 "$APP_DIR/nginx/files.scardrone.cc.http.conf" "$NGINX_AVAILABLE"
  ln -s "$NGINX_AVAILABLE" "$NGINX_ENABLED"
fi

if ! nginx -t; then
  if [[ "$INITIAL_INSTALL" -eq 1 ]]; then
    rm -f "$NGINX_ENABLED" "$NGINX_AVAILABLE" "$SERVICE_FILE"
    echo "Nginx validation failed. The new SCAR FILES Nginx files were removed." >&2
  else
    echo "Nginx validation failed. Existing site files were left untouched." >&2
  fi
  exit 1
fi

systemctl daemon-reload
if [[ "$INITIAL_INSTALL" -eq 1 ]]; then
  systemctl enable --now scar-files
else
  systemctl restart scar-files
fi
systemctl reload nginx

if [[ "$INITIAL_INSTALL" -eq 1 ]]; then
  echo "SCAR FILES is installed. Review $ENV_FILE, add the admin, then issue its HTTPS certificate."
else
  echo "SCAR FILES has been updated. Its data and Nginx site configuration were preserved."
fi

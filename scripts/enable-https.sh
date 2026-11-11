#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this command with sudo on the Ubuntu server." >&2
  exit 1
fi

APP_DIR="/var/www/scardrone-files"
AVAILABLE="/etc/nginx/sites-available/scar-files-https.conf"
ENABLED="/etc/nginx/sites-enabled/files.scardrone.cc"
HTTP_AVAILABLE="/etc/nginx/sites-available/scar-files-http.conf"

if [[ ! -f /etc/letsencrypt/live/files.scardrone.cc/fullchain.pem || ! -f /etc/letsencrypt/live/files.scardrone.cc/privkey.pem ]]; then
  echo "The files.scardrone.cc certificate is missing. Obtain it with Certbot webroot mode first." >&2
  exit 1
fi
if [[ ! -L "$ENABLED" || "$(readlink -f "$ENABLED")" != "$HTTP_AVAILABLE" ]]; then
  echo "The enabled files.scardrone.cc site is not the HTTP site installed by SCAR FILES. Nothing was changed." >&2
  exit 1
fi
if [[ -e "$AVAILABLE" ]]; then
  echo "The SCAR FILES HTTPS site file already exists. Nothing was overwritten." >&2
  exit 1
fi

install -m 0644 "$APP_DIR/nginx/files.scardrone.cc.https.conf" "$AVAILABLE"
TEMP_LINK="${ENABLED}.new"
ln -s "$AVAILABLE" "$TEMP_LINK"
mv -Tf "$TEMP_LINK" "$ENABLED"
if ! nginx -t; then
  rm -f "$ENABLED" "$AVAILABLE"
  ln -s "$HTTP_AVAILABLE" "$ENABLED"
  echo "Nginx validation failed. The original SCAR FILES HTTP site was restored." >&2
  exit 1
fi

HOOK="/etc/letsencrypt/renewal-hooks/deploy/50-scar-files-nginx-reload"
if [[ ! -e "$HOOK" ]]; then
  install -d -m 0755 "$(dirname "$HOOK")"
  cat > "$HOOK" <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
  chmod 0755 "$HOOK"
fi
systemctl reload nginx
echo "HTTPS is enabled for files.scardrone.cc. The existing Nginx sites were not changed."

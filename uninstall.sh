#!/usr/bin/env bash
# Removes this gateway from the server: its containers, database, images, backup cron job and
# (optionally) the project directory. Other Docker projects on the server are not touched.
# Usage (as root, from the project directory):  sudo bash uninstall.sh
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash uninstall.sh"
[ -f docker-compose.yml ] || die "Run this from the trafxpayment project directory"

echo "This permanently deletes the gateway in $APP_DIR:"
echo "  - containers: $(docker compose --profile caddy ps -a --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')"
echo "  - the database (all merchants, invoices, balances) and the wallet keys in .env.signer"
if [ -f .env.signer ]; then
  warn "The 24 recovery words in .env.signer control every deposit and hot wallet."
  warn "If any of those wallets still hold funds, write the words down BEFORE continuing:"
  warn "  grep SIGNER_MNEMONIC $APP_DIR/.env.signer"
fi
read -r -p "Type DELETE to continue: " answer
[ "$answer" = DELETE ] || die "Cancelled, nothing was removed."

IMAGES="$(docker compose --profile caddy config --images 2>/dev/null | sort -u || true)"
docker compose --profile caddy down --volumes --remove-orphans
for img in $IMAGES; do docker image rm "$img" >/dev/null 2>&1 && echo "removed image $img" || true; done
rm -f /etc/cron.d/trafxpayment-backup

if ls /opt/backups/db-*.sql.gz >/dev/null 2>&1; then
  read -r -p "Delete the database backups in /opt/backups? [y/N]: " answer
  [[ "$answer" =~ ^[Yy] ]] && rm -f /opt/backups/db-*.sql.gz
fi
read -r -p "Delete the project directory $APP_DIR (including .env and .env.signer)? [y/N]: " answer
if [[ "$answer" =~ ^[Yy] ]]; then
  cd / && rm -rf "$APP_DIR"
  echo "Removed $APP_DIR."
fi
echo "Done."

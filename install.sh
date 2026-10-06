#!/usr/bin/env bash
# One-shot installer for a single Ubuntu server (22.04 / 24.04).
# Usage (as root, from the project directory):  sudo bash install.sh
# Re-running it on an installed server only rebuilds and restarts; keys and .env are never overwritten.
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash install.sh"
[ -f docker-compose.yml ] || die "Run this from the trafxpayment project directory"

set_env() { # set_env KEY VALUE FILE
  local key="$1" file="$3" value
  value="$(printf '%s' "$2" | sed -e 's/[&|\\]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ask() { # ask VAR "prompt" [default]
  local __var="$1" prompt="$2" def="${3:-}" reply
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " reply; reply="${reply:-$def}"
  else read -r -p "$prompt: " reply; fi
  printf -v "$__var" '%s' "$reply"
}

# ---------------------------------------------------------------- packages
say "Installing system packages"
apt-get update -qq
apt-get install -y -qq git curl openssl ufw cron >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

say "Configuring firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- already installed? just update
if [ -f .env ]; then
  say "Existing installation found (.env present) — rebuilding and restarting only"
  docker compose up -d --build
  docker compose ps
  exit 0
fi

# ---------------------------------------------------------------- questions
say "Configuration"
echo "Leave optional answers empty to skip. You can edit $APP_DIR/.env later and re-run: docker compose up -d"
ask DOMAIN       "Domain for the gateway (DNS A record must point to this server), e.g. pay.example.com"
[ -n "$DOMAIN" ] || die "Domain is required"
ask ACME_EMAIL   "Email for the SSL certificate (Let's Encrypt)"
ask ADMIN_EMAIL  "Admin panel login email" "$ACME_EMAIL"
while :; do
  read -r -s -p "Admin panel password (min 10 chars): " ADMIN_PASSWORD; echo
  [ "${#ADMIN_PASSWORD}" -ge 10 ] && break
  warn "Too short"
done
ask FEE          "Default fee percent for merchants" "1"
ask TRON_KEY     "TronGrid API key (trongrid.io) — strongly recommended" ""
ask TON_KEY      "toncenter API key (@tonapibot on Telegram) — strongly recommended" ""
ask PRICE_KEY    "CoinGecko demo API key (optional)" ""
ask BSC_RPC      "BSC RPC URL" "https://bsc-dataseed.bnbchain.org"
ask ETH_RPC      "Ethereum RPC URL (empty = Ethereum disabled)" ""
ask POLYGON_RPC  "Polygon RPC URL (empty = Polygon disabled)" ""

SERVER_IP="$(curl -s -4 --max-time 5 https://api.ipify.org || true)"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  warn "$DOMAIN resolves to '${DOMAIN_IP:-nothing}', but this server is $SERVER_IP."
  warn "HTTPS will not work until the DNS A record points here (it retries automatically)."
fi

# ---------------------------------------------------------------- .env
say "Writing .env"
DB_PASSWORD="$(openssl rand -hex 24)"
cp .env.example .env
chmod 600 .env
set_env POSTGRES_PASSWORD "$DB_PASSWORD" .env
set_env DATABASE_URL "postgres://postgres:${DB_PASSWORD}@db:5432/trafxpayment" .env
set_env NODE_ENV production .env
set_env DOMAIN "$DOMAIN" .env
set_env ACME_EMAIL "$ACME_EMAIL" .env
set_env PUBLIC_BASE_URL "https://$DOMAIN" .env
set_env DEFAULT_FEE_PERCENT "$FEE" .env
set_env TRON_API_KEY "$TRON_KEY" .env
set_env TON_API_KEY "$TON_KEY" .env
set_env PRICE_API_KEY "$PRICE_KEY" .env
set_env BSC_RPC_URL "$BSC_RPC" .env
set_env ETH_RPC_URL "$ETH_RPC" .env
set_env POLYGON_RPC_URL "$POLYGON_RPC" .env

# ---------------------------------------------------------------- build + keys
say "Building the application image (takes a few minutes)"
docker compose build

say "Generating wallet keys"
KEYS="$(docker compose run --rm --no-deps -T api node dist/bin/generate-keys.js)"
MNEMONIC="$(printf '%s\n' "$KEYS" | sed -n 's/^SIGNER_MNEMONIC="\(.*\)"$/\1/p')"
EVM_XPUB="$(printf '%s\n' "$KEYS" | sed -n 's/^EVM_XPUB=//p')"
TRON_XPUB="$(printf '%s\n' "$KEYS" | sed -n 's/^TRON_XPUB=//p')"
TON_TREASURY="$(printf '%s\n' "$KEYS" | sed -n 's/^TON_TREASURY_ADDRESS=//p')"
HOT_WALLETS="$(printf '%s\n' "$KEYS" | grep 'hot wallet')"
[ -n "$MNEMONIC" ] && [ -n "$EVM_XPUB" ] && [ -n "$TRON_XPUB" ] && [ -n "$TON_TREASURY" ] || die "Key generation failed"

set_env EVM_XPUB "$EVM_XPUB" .env
set_env TRON_XPUB "$TRON_XPUB" .env
set_env TON_TREASURY_ADDRESS "$TON_TREASURY" .env

cp .env.signer.example .env.signer
chmod 600 .env.signer
set_env SIGNER_MNEMONIC "$MNEMONIC" .env.signer

# ---------------------------------------------------------------- start
say "Starting services"
docker compose up -d

say "Waiting for the API"
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:3000/health >/dev/null && break
  sleep 2
done
curl -sf http://127.0.0.1:3000/health >/dev/null || die "API did not start. Check: docker compose logs api"

say "Creating admin account"
docker compose run --rm -T api node dist/bin/create-admin.js --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD"

# ---------------------------------------------------------------- daily DB backup
say "Installing daily database backup (/opt/backups, kept 14 days)"
mkdir -p /opt/backups
cat > /etc/cron.d/trafxpayment-backup <<EOF
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root cd $APP_DIR && docker compose exec -T db pg_dump -U postgres trafxpayment | gzip > /opt/backups/db-\$(date +\%F).sql.gz && find /opt/backups -name 'db-*.sql.gz' -mtime +14 -delete
EOF
chmod 644 /etc/cron.d/trafxpayment-backup

# ---------------------------------------------------------------- summary
cat <<EOF

=====================================================================
  Installation complete
=====================================================================
  Payment gateway : https://$DOMAIN
  Admin panel     : https://$DOMAIN/admin   ($ADMIN_EMAIL)
  Merchant panel  : https://$DOMAIN/panel

  WRITE THESE 24 WORDS ON PAPER NOW. They control ALL funds.
  Whoever has them has the money. Never send them to anyone,
  never store them in chat / email / screenshots.

  $MNEMONIC

  (A copy is in $APP_DIR/.env.signer — readable by root only.)

  Fund these hot wallets with network fees before going live:
$HOT_WALLETS

  Next: open the admin panel, create a merchant, then test every
  network with a tiny real payment before accepting customers.
=====================================================================
EOF

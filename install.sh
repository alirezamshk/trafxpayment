#!/usr/bin/env bash
# One-shot installer for a single Ubuntu server (22.04 / 24.04).
# Usage (as root, from the project directory):  sudo bash install.sh
# Re-running it on an installed server only rebuilds and restarts; keys and .env are never overwritten.
#
# Works next to other services: the web port can be 80/443, any other port (certificate via
# Cloudflare DNS), or behind a reverse proxy that already runs on this server. An HTTP proxy can be
# used for everything that needs the internet (Docker images, npm, blockchain APIs) — e.g. in Iran.
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
get_env() { sed -n "s/^$1=//p" "${2:-.env}" | tail -n1; }

ask() { # ask VAR "prompt" [default]
  local __var="$1" prompt="$2" def="${3:-}" reply
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " reply; reply="${reply:-$def}"
  else read -r -p "$prompt: " reply; fi
  printf -v "$__var" '%s' "$reply"
}
yes_no() { # yes_no "question" default(y|n)
  local reply; read -r -p "$1 [$2]: " reply; reply="${reply:-$2}"
  [[ "$reply" =~ ^[Yy] ]]
}

# A port is busy if something listens on it or a container publishes it.
port_busy() {
  local p="$1"
  [ -n "$(ss -ltnH "( sport = :$p )" 2>/dev/null)" ] && return 0
  command -v docker >/dev/null 2>&1 && docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$p->" && return 0
  return 1
}

use_proxy() { # export a proxy for this shell (apt, curl, docker install script)
  export http_proxy="$1" https_proxy="$1" HTTP_PROXY="$1" HTTPS_PROXY="$1"
  export no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1"
}
no_proxy_env() { env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY "$@"; }

docker_daemon_proxy() { # make dockerd pull images through the proxy
  mkdir -p /etc/systemd/system/docker.service.d
  printf '[Service]\nEnvironment="HTTP_PROXY=%s"\nEnvironment="HTTPS_PROXY=%s"\nEnvironment="NO_PROXY=localhost,127.0.0.1,::1"\n' "$1" "$1" \
    > /etc/systemd/system/docker.service.d/http-proxy.conf
  systemctl daemon-reload
  systemctl restart docker
}

install_backup_cron() {
  mkdir -p /opt/backups
  printf '%s\n' \
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    "0 3 * * * root cd $APP_DIR && docker compose exec -T db pg_dump -U postgres trafxpayment | gzip > /opt/backups/db-\$(date +\\%F).sql.gz && find /opt/backups -name 'db-*.sql.gz' -mtime +14 -delete" \
    > /etc/cron.d/trafxpayment-backup
  chmod 644 /etc/cron.d/trafxpayment-backup
}

# Checks from inside a container that the blockchain APIs are reachable (through OUTBOUND_PROXY if set).
check_outbound() {
  local url
  url="$(get_env TRON_API_URL)"; url="${url:-https://api.trongrid.io}"
  docker compose run --rm --no-deps -T api node --input-type=module -e "
    import { installOutboundProxy } from './dist/lib/proxy.js';
    installOutboundProxy(process.env.OUTBOUND_PROXY, () => {});
    try { const r = await fetch('$url/wallet/getnowblock', { method: 'POST', signal: AbortSignal.timeout(15000) }); console.log('HTTP ' + r.status); }
    catch (e) { console.log('FAILED: ' + (e.cause?.message ?? e.message)); process.exit(1); }" 2>&1 | grep -E '^(HTTP|FAILED)' | tail -n1
}

# ---------------------------------------------------------------- already installed? just update
if [ -f .env ]; then
  say "Existing installation found (.env present) — rebuilding and restarting only (keys are kept)"
  grep -q '^COMPOSE_PROFILES=' .env || set_env COMPOSE_PROFILES caddy .env   # installs from before ports were configurable
  docker compose up -d --build --remove-orphans
  install_backup_cron
  docker compose ps
  echo
  echo "Create / reset the admin login:"
  echo "  docker compose run --rm api node dist/bin/create-admin.js --email you@example.com --password 'min-10-chars'"
  echo "Show the 24 recovery words:  grep SIGNER_MNEMONIC $APP_DIR/.env.signer"
  exit 0
fi

# ---------------------------------------------------------------- proxy (asked first: installing needs the internet)
say "Internet access"
echo "If this server cannot reach international sites directly (e.g. in Iran), give an HTTP proxy."
echo "Examples: http://127.0.0.1:10809 (proxy app on this server), http://user:pass@1.2.3.4:3128"
echo "SOCKS-only proxies are not supported — enable the HTTP inbound of your proxy app."
ask PROXY "HTTP proxy URL (empty = direct connection)" ""
if [ -n "$PROXY" ]; then
  [[ "$PROXY" =~ ^https?:// ]] || die "Proxy must start with http:// or https://"
  if curl -sS -o /dev/null --max-time 20 -x "$PROXY" https://api.trongrid.io; then
    echo "Proxy works."
  else
    die "Could not reach https://api.trongrid.io through $PROXY — check the proxy and re-run."
  fi
fi

# ---------------------------------------------------------------- packages
say "Installing system packages"
if ! no_proxy_env apt-get update -qq; then
  [ -n "$PROXY" ] || die "apt-get update failed"
  warn "apt-get update failed directly — retrying through the proxy"
  use_proxy "$PROXY"; apt-get update -qq
fi
apt-get install -y -qq git curl openssl cron iproute2 >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  ( [ -n "$PROXY" ] && use_proxy "$PROXY"; curl -fsSL https://get.docker.com | sh )
fi
systemctl enable --now docker >/dev/null

if [ -n "$PROXY" ] && ! grep -qs HTTPS_PROXY /etc/systemd/system/docker.service.d/http-proxy.conf; then
  say "Checking Docker Hub access"
  if timeout 90 docker pull -q postgres:16-alpine >/dev/null 2>&1; then
    echo "Docker Hub is reachable directly."
  else
    warn "Docker cannot download images directly (Docker Hub blocks some countries)."
    if [ -n "$(docker ps -q)" ]; then
      warn "Configuring Docker to use the proxy restarts Docker: your running containers stop briefly"
      warn "(containers with a restart policy start again; others must be started by hand)."
    fi
    if yes_no "Configure Docker to download images through $PROXY?" y; then
      docker_daemon_proxy "$PROXY"
    else
      die "Docker needs to download images. Configure a registry mirror in /etc/docker/daemon.json, then re-run."
    fi
  fi
fi

# ---------------------------------------------------------------- questions
say "Configuration"
echo "Leave optional answers empty to skip. You can edit $APP_DIR/.env later and re-run: docker compose up -d"
ask DOMAIN "Domain for the gateway (DNS A record must point to this server), e.g. pay.example.com"
[ -n "$DOMAIN" ] || die "Domain is required"

echo
echo "How should visitors reach the gateway?"
echo "  1) HTTPS on ports 80 + 443 (standard, the ports must be free)"
echo "  2) HTTPS on another port, e.g. https://$DOMAIN:8443 (certificate via Cloudflare DNS;"
echo "     the domain's DNS must be on Cloudflare — use when 80/443 are taken by something else)"
echo "  3) Behind a reverse proxy that already runs on this server (nginx, Caddy, Traefik,"
echo "     Nginx Proxy Manager...) — it keeps 80/443 and forwards $DOMAIN to the gateway"
WEB_DEFAULT=1
if port_busy 80 || port_busy 443; then
  WEB_DEFAULT=2
  warn "Port 80 or 443 is already in use on this server:"
  ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true
  docker ps --format '  container {{.Names}}: {{.Ports}}' 2>/dev/null | grep -E ':(80|443)->' || true
fi
ask WEB_MODE "Choose 1, 2 or 3" "$WEB_DEFAULT"

HTTP_PORT=80; HTTPS_PORT=443; CADDY_TARGET=plain; CF_API_TOKEN=""; PROFILES=caddy
API_BIND=127.0.0.1; API_PORT=3000; ACME_EMAIL=""
case "$WEB_MODE" in
  1)
    if port_busy 80 || port_busy 443; then
      for svc in caddy nginx apache2 httpd; do
        if systemctl is-active --quiet "$svc" 2>/dev/null && yes_no "System service '$svc' uses port 80/443. Stop and disable it?" n; then
          systemctl disable --now "$svc" >/dev/null 2>&1 || true
        fi
      done
      if port_busy 80 || port_busy 443; then
        die "Ports 80/443 are still in use. Re-run and choose option 2 or 3."
      fi
    fi
    ask ACME_EMAIL "Email for the SSL certificate (Let's Encrypt)"
    PUBLIC_URL="https://$DOMAIN"
    ;;
  2)
    CADDY_TARGET=cloudflare
    echo "Ports Cloudflare can proxy (orange cloud): 2053 2083 2087 2096 8443 — any free port works with DNS only (grey cloud)."
    while :; do
      ask HTTPS_PORT "HTTPS port" "8443"
      [[ "$HTTPS_PORT" =~ ^[0-9]+$ ]] && ! port_busy "$HTTPS_PORT" && break
      warn "Port $HTTPS_PORT is not a number or is already in use"
    done
    # caddy still listens on :80 inside its container (HTTP->HTTPS redirect); keep it off the public interface.
    HTTP_PORT="127.0.0.1:$((HTTPS_PORT + 1))"
    while port_busy "${HTTP_PORT#127.0.0.1:}"; do HTTP_PORT="127.0.0.1:$(( ${HTTP_PORT#127.0.0.1:} + 1 ))"; done
    echo
    echo "Create a Cloudflare API token: dash.cloudflare.com → My Profile → API Tokens → Create Token"
    echo "→ template 'Edit zone DNS' → Zone Resources: the zone of $DOMAIN."
    while [ -z "$CF_API_TOKEN" ]; do read -r -s -p "Cloudflare API token: " CF_API_TOKEN; echo; done
    ask ACME_EMAIL "Email for the SSL certificate (Let's Encrypt)"
    PUBLIC_URL="https://$DOMAIN"; [ "$HTTPS_PORT" = 443 ] || PUBLIC_URL="https://$DOMAIN:$HTTPS_PORT"
    ;;
  3)
    PROFILES=""
    DOCKER0_IP="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
    echo "The gateway API will listen on plain HTTP; your reverse proxy terminates HTTPS and forwards to it."
    echo "Bind ${DOCKER0_IP:-172.17.0.1} = reachable from the host and from containers, not from the internet."
    ask API_BIND "Bind address" "${DOCKER0_IP:-127.0.0.1}"
    while :; do
      ask API_PORT "Port" "3080"
      [[ "$API_PORT" =~ ^[0-9]+$ ]] && ! port_busy "$API_PORT" && break
      warn "Port $API_PORT is not a number or is already in use"
    done
    ask PUBLIC_URL "Public URL of the gateway (as visitors see it)" "https://$DOMAIN"
    ;;
  *) die "Choose 1, 2 or 3" ;;
esac
PUBLIC_URL="${PUBLIC_URL%/}"

echo
echo "Blockchain network:"
echo "  1) mainnet — real money"
echo "  2) testnet — TRON Nile, BSC testnet, TON testnet (free test coins, for trying everything out)"
ask NET_MODE "Choose 1 or 2" "1"

ask ADMIN_EMAIL "Admin panel login email" "${ACME_EMAIL:-admin@$DOMAIN}"
while :; do
  read -r -s -p "Admin panel password (min 10 chars): " ADMIN_PASSWORD; echo
  [ "${#ADMIN_PASSWORD}" -ge 10 ] && break
  warn "Too short"
done
ask FEE "Default fee percent for merchants" "1"
if [ "$NET_MODE" = 2 ]; then
  TRON_KEY=""; ETH_RPC=""; POLYGON_RPC=""
  ask TRON_USDT "USDT contract on TRON Nile (check it on nile.tronscan.org)" "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
  ask TON_KEY "toncenter TESTNET API key (@tontestnetapibot on Telegram, optional)" ""
  ask BSC_RPC "BSC testnet RPC URL" "https://data-seed-prebsc-1-s1.bnbchain.org:8545"
else
  ask TRON_KEY "TronGrid API key (trongrid.io) — strongly recommended" ""
  ask TON_KEY "toncenter API key (@tonapibot on Telegram) — strongly recommended" ""
  ask BSC_RPC "BSC RPC URL" "https://bsc-dataseed.bnbchain.org"
  ask ETH_RPC "Ethereum RPC URL (empty = Ethereum disabled)" ""
  ask POLYGON_RPC "Polygon RPC URL (empty = Polygon disabled)" ""
fi
ask PRICE_KEY "CoinGecko demo API key (optional)" ""

if [ "$WEB_MODE" != 3 ]; then
  SERVER_IP="$(curl -s -4 --noproxy '*' --max-time 5 https://api.ipify.org || true)"
  DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
  if [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
    warn "$DOMAIN resolves to '${DOMAIN_IP:-nothing}', but this server is $SERVER_IP."
    warn "Ignore this if the domain is proxied by Cloudflare; otherwise point the DNS A record here."
  fi
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
set_env PUBLIC_BASE_URL "$PUBLIC_URL" .env
set_env COMPOSE_PROFILES "$PROFILES" .env
set_env HTTP_PORT "$HTTP_PORT" .env
set_env HTTPS_PORT "$HTTPS_PORT" .env
set_env CADDY_TARGET "$CADDY_TARGET" .env
set_env CF_API_TOKEN "$CF_API_TOKEN" .env
set_env API_BIND "$API_BIND" .env
set_env API_PORT "$API_PORT" .env
# Containers reach a proxy on this host through host.docker.internal, not 127.0.0.1.
set_env OUTBOUND_PROXY "$(printf '%s' "$PROXY" | sed -E 's#(://([^@/]*@)?)(127\.0\.0\.1|localhost)([:/]|$)#\1host.docker.internal\4#')" .env
set_env BUILD_PROXY "$PROXY" .env
set_env DEFAULT_FEE_PERCENT "$FEE" .env
set_env TRON_API_KEY "$TRON_KEY" .env
set_env TON_API_KEY "$TON_KEY" .env
set_env PRICE_API_KEY "$PRICE_KEY" .env
set_env BSC_RPC_URL "$BSC_RPC" .env
set_env ETH_RPC_URL "$ETH_RPC" .env
set_env POLYGON_RPC_URL "$POLYGON_RPC" .env
if [ "$NET_MODE" = 2 ]; then
  set_env NETWORK_MODE testnet .env
  set_env TRON_API_URL https://nile.trongrid.io .env
  set_env TRON_USDT_CONTRACT "$TRON_USDT" .env
  set_env BSC_USDT_CONTRACT 0x337610d27c682E347C9cD60BD4b3b107C9d34dDd .env
  set_env BSC_CONFIRMATIONS 3 .env
  set_env TON_API_URL https://testnet.toncenter.com/api/v3 .env
  set_env TON_V2_RPC_URL https://testnet.toncenter.com/api/v2/jsonRPC .env
else
  set_env NETWORK_MODE mainnet .env
fi

# ---------------------------------------------------------------- build + keys
say "Building the application images (takes a few minutes)"
docker compose build

if [ -n "$PROXY" ]; then
  say "Checking that the services can reach the blockchain APIs through the proxy"
  RESULT="$(check_outbound || true)"
  echo "$RESULT"
  if [[ "$RESULT" != HTTP* ]]; then
    warn "Containers cannot use the proxy at $(get_env OUTBOUND_PROXY)."
    warn "A proxy app on this server must listen on 0.0.0.0 (or ${DOCKER0_IP:-172.17.0.1}), not only 127.0.0.1,"
    warn "e.g. in xray/v2ray set the HTTP inbound \"listen\": \"0.0.0.0\" (and block that port from the internet)."
    warn "Fix it, set OUTBOUND_PROXY in $APP_DIR/.env if needed, then: docker compose up -d"
  fi
fi

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
LOCAL_API="http://${API_BIND/0.0.0.0/127.0.0.1}:$API_PORT"
for _ in $(seq 1 60); do
  curl -sf --noproxy '*' "$LOCAL_API/health" >/dev/null && break
  sleep 2
done
curl -sf --noproxy '*' "$LOCAL_API/health" >/dev/null || die "API did not start. Check: docker compose logs api"

say "Creating admin account"
docker compose run --rm -T api node dist/bin/create-admin.js --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Opening the web port(s) in ufw"
  case "$WEB_MODE" in
    1) ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null ;;
    2) ufw allow "$HTTPS_PORT/tcp" >/dev/null ;;
  esac
fi

# ---------------------------------------------------------------- daily DB backup
say "Installing daily database backup (/opt/backups, kept 14 days)"
install_backup_cron

# ---------------------------------------------------------------- summary
FORWARD_NOTE=""
if [ "$WEB_MODE" = 3 ]; then
  FORWARD_NOTE="
  Reverse proxy   : forward $DOMAIN to http://$API_BIND:$API_PORT
                    (keep the Host header, set X-Forwarded-For and X-Forwarded-Proto)"
fi
cat <<EOF

=====================================================================
  Installation complete ($(get_env NETWORK_MODE))
=====================================================================
  Payment gateway : $PUBLIC_URL
  Admin panel     : $PUBLIC_URL/admin   ($ADMIN_EMAIL)
  Merchant panel  : $PUBLIC_URL/panel$FORWARD_NOTE

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

# TrafxPayment — notes for Claude

Multi-merchant crypto payment gateway (like NOWPayments). Owner: Alireza. **Always reply in Persian (فارسی)**,
short and step by step — the owner prefers one clear action at a time. Develop and push only on
branch `claude/lucid-hamilton-aez7rd`.

## Stack and layout
- Node 22 + TypeScript, Fastify, raw SQL migrations (`migrations/NNN_*.sql`), zod, vitest.
- Processes: `api` (panels + merchant API), `worker` (chain watchers, webhooks, settlements, TLS cert job),
  `signer` (the only process with the 24-word mnemonic: sweeps, payouts, cold storage, hot-wallet report).
- Frontend: plain HTML/JS in `public/` (`app.js`, `app.css`, `i18n.js` fa/en, `admin.html`, `panel.html`, `pay.html`).
- Chains: TRON (TRX, USDT-TRC20), BSC/ETH/Polygon (EVM), TON. HD wallets: deposit addresses = account 0,
  hot wallets = account 1 (`src/wallet/hd.ts`); API/worker hold only xpubs.

## Deployment
- `install.sh` (interactive) + Docker Compose. Images are built by GitHub Actions
  (`.github/workflows/images.yml`) and published to `ghcr.io/alirezamshk/trafxpayment{,-postgres,-caddy}`;
  the installer pulls them (falls back to a local build with Docker Hub/npm mirrors).
- `uninstall.sh` removes only this project. Re-running `install.sh` on an installed server = update.
- Production server is in Iran, domain `payment.trafx.cloud` behind Cloudflare (orange cloud, SSL Full (strict)),
  installer web mode 2 (Caddy + Let's Encrypt on 80/443, only Cloudflare IPs trusted for X-Forwarded-For).
  Docker Hub is blocked there; outbound blockchain APIs work directly (proxy optional, admin → پراکسی و اتصال).
- Secrets live only on the server (`.env`, `.env.signer`). Never ask for or repeat the mnemonic.

## Status (2026-11)
- Full TRX flow tested on TRON Nile testnet: invoice → payment → confirm → fee → sweep → payout. ✅
- Mainnet installed fresh (new mnemonic). Owner decided to use **USDT-BEP20 + TRX** (USDT-TRC20 disabled
  in admin currency settings because of its transfer cost).
- Next: small real-money test ($1) with TRX and USDT-BEP20 on mainnet, including payout; then set cold
  wallets (`COLD_WALLET_*` in `.env.signer`).
- Later ideas: NOWPayments-compatible API, Telegram notifications (needs proxy in Iran), TRON energy rental.

## Working locally
- Tests need Postgres on port 54329 (`test/setup.ts`, `TEST_DATABASE_URL` overrides). In this sandbox:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/trafxpg/data -o '-p 54329' -l /var/tmp/trafxpg/pg2.log start"`
- Check before pushing: `npx tsc --noEmit && npx vitest run`.
- Commit messages end with the Co-Authored-By / Claude-Session lines from the session's attribution reminder.

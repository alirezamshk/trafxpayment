import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { findAsset } from '../chains/assets.js';
import { fromBaseUnits, toBaseUnits } from '../lib/amount.js';
import { invoices, ledger } from '../services/index.js';
import { createApiKey, createMerchant, getMerchant, listMerchants } from '../services/merchants.js';
import { audit, auditList } from '../services/audit.js';
import { getProxySetting, setProxySetting, testConnectivity } from '../services/network.js';
import { getCertificate, getCertificateStatus } from '../services/certificates.js';
import { getBackupSettings, getBackupStatus, maskToken, saveBackupSettings, sendBackup, sendTestMessage, type BackupSettings } from '../services/backup.js';
import { getWalletReport } from '../sweeper/signer.js';
import { config } from '../config.js';
import { applyOutboundProxy, maskProxyUrl, parseProxyUrl } from '../lib/proxy.js';
import { requireAdminSession } from './auth.js';
import { otpFromRequest, requireOtp, resetTwoFactor, twoFactorRoutes } from './twofactor.js';
import { balancesView, listInvoices, listQuery, payoutsView } from './merchant-api.js';
import { dailyStats, merchantView, payoutAddressesView, statsQuery } from './panel.js';
import { httpError, parse } from './util.js';

const fmt = (asset: string, v: string) => {
  const a = findAsset(invoices.registry, asset);
  return a ? fromBaseUnits(v, a.decimals) : v;
};

/** Platform operator API (cookie session, role=admin). */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdminSession);
  await app.register(twoFactorRoutes('admin', (req) => req.adminId!));

  // With 2FA enabled every admin change needs a fresh code, and every successful change is audited.
  // (A connectivity test changes nothing, so it needs no code and is not audited.)
  const isMutation = (method: string, url: string) => method !== 'GET' && !url.includes('/2fa') && !url.startsWith('/api/admin/network/test') && !url.startsWith('/api/admin/backup/test');
  app.addHook('preHandler', async (req) => {
    if (req.adminId && isMutation(req.method, req.url)) await requireOtp('admin', req.adminId, otpFromRequest(req));
  });
  // onSend (not onResponse) so the audit row exists before the admin sees the change succeed.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.adminId || !isMutation(req.method, req.url) || reply.statusCode >= 400) return payload;
    const { password: _p, ...body } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.url === 'string') body.url = maskProxyUrl(body.url); // proxy credentials stay out of the log
    if (typeof body.bot_token === 'string') body.bot_token = maskToken(body.bot_token);
    if ('backup_password' in body) body.backup_password = body.backup_password ? '***' : body.backup_password;
    const params = req.params as Record<string, string>;
    await audit(pool, {
      actorType: 'admin',
      actorId: req.adminId,
      merchantId: params.id && req.url.includes('/merchants/') ? params.id : null,
      action: `admin ${req.method} ${req.routeOptions.url ?? req.url}`,
      details: { params, body },
      ip: req.ip,
    }).catch((err) => req.log.error(err));
    return payload;
  });

  app.get('/stats', async (req) => ({ data: await dailyStats(null, parse(statsQuery, req.query).days) }));

  app.get('/audit', async (req) => {
    const q = parse(z.object({ merchant_id: z.string().uuid().optional() }), req.query);
    return { data: await auditList(pool, { merchantId: q.merchant_id, limit: 300 }) };
  });
  app.get('/me', async (req) => {
    const { rows } = await pool.query<{ email: string; totp_enabled: boolean }>('SELECT email, totp_enabled FROM admins WHERE id = $1', [req.adminId]);
    return rows[0];
  });
  app.post<{ Params: { id: string } }>('/merchants/:id/reset-2fa', async (req) => {
    await resetTwoFactor('merchant', req.params.id);
    return { ok: true };
  });

  app.get('/summary', async () => {
    const totals = await ledger.platformSummary(pool);
    const { rows: counts } = await pool.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*) AS n FROM invoices WHERE created_at > now() - interval '30 days' GROUP BY status`,
    );
    const { rows: pending } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM payouts WHERE status = 'pending_approval'`);
    const { rows: unmatched } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM deposits WHERE invoice_id IS NULL`);
    return {
      assets: totals.map((t) => ({
        asset: t.asset,
        platform_fees: fmt(t.asset, t.fees),
        payout_fees: fmt(t.asset, t.payout_fees),
        network_fees: fmt(t.asset, t.network_fees),
        merchant_balances: fmt(t.asset, t.merchant_balances),
        volume: fmt(t.asset, t.volume),
      })),
      invoices_30d: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      payouts_pending_approval: Number(pending[0]!.n),
      unmatched_deposits: Number(unmatched[0]!.n),
      available_assets: invoices.availableAssets(),
    };
  });

  // --- per-asset settings (sweep threshold, payout network fee)
  app.get('/asset-settings', async () => ({
    data: await ledger.settings.view(pool, invoices.availableAssets().map((a) => a.id)),
  }));
  // Platform-wide on/off per currency (e.g. switch off USDT-TRC20 when its network cost is too high).
  app.put('/asset-settings/enabled', async (req) => {
    const b = parse(z.object({ asset: z.string(), enabled: z.boolean() }), req.body);
    const asset = invoices.asset(b.asset);
    if (!b.enabled) {
      const others = (await invoices.activeAssets()).filter((a) => a.id !== asset.id);
      if (!others.length) throw httpError(400, 'no_assets', 'At least one currency must stay enabled');
    }
    await ledger.settings.setEnabled(pool, asset.id, b.enabled);
    return { ok: true };
  });
  app.put('/asset-settings', async (req) => {
    const dec = z.string().trim().regex(/^\d+(\.\d+)?$/);
    const b = parse(
      z.object({ asset: z.string(), sweep_threshold: dec, payout_fee: dec, min_amount: dec, deposit_fee: dec, hot_max: dec }),
      req.body,
    );
    const asset = invoices.asset(b.asset);
    const u = (v: string) => {
      try {
        return toBaseUnits(v, asset.decimals);
      } catch (e) {
        throw httpError(400, 'invalid_amount', (e as Error).message);
      }
    };
    await ledger.settings.set(pool, asset.id, {
      sweepThreshold: u(b.sweep_threshold),
      payoutFee: u(b.payout_fee),
      minAmount: u(b.min_amount),
      depositFee: u(b.deposit_fee),
      hotMax: u(b.hot_max),
    });
    return { ok: true };
  });

  // --- outbound proxy (blockchain APIs, prices, Telegram, webhooks)
  const proxyView = async () => {
    const p = await getProxySetting(pool);
    return { url: maskProxyUrl(p.url), source: p.source, tls: await tlsView() };
  };
  // HTTPS certificate managed by the worker (API_TLS=acme-dns); null when caddy / a reverse proxy does TLS.
  const tlsView = async () => {
    if (config.API_TLS !== 'acme-dns') return null;
    const [c, st] = await Promise.all([getCertificate(pool), getCertificateStatus(pool)]);
    return { domain: config.DOMAIN, issuer: c?.issuer ?? null, not_after: c?.not_after ?? null, status: st };
  };
  const proxyUrlInput = z.object({ url: z.string().trim().max(500).nullable().optional() });
  const checkedProxy = (url: string | null | undefined) => {
    if (!url) return null;
    try {
      return parseProxyUrl(url).toString();
    } catch (e) {
      throw httpError(400, 'invalid_proxy', (e as Error).message);
    }
  };
  // --- nightly encrypted database backup to Telegram
  const backupView = async () => {
    const s = await getBackupSettings(pool);
    return { enabled: s.enabled, bot_token: maskToken(s.bot_token), chat_id: s.chat_id, has_password: !!s.password, hour: s.hour, status: await getBackupStatus(pool) };
  };
  const backupInput = z.object({
    enabled: z.boolean(),
    bot_token: z.string().trim().max(200).nullable().optional(),
    chat_id: z.string().trim().max(64).nullable().optional(),
    backup_password: z.string().min(8).max(200).nullable().optional(), // omitted / null = keep the saved one
    hour: z.number().int().min(0).max(23),
  });
  // Merges the request with the saved settings; a masked token (as shown in the panel) keeps the saved one.
  const mergedBackup = async (body: unknown): Promise<BackupSettings> => {
    const b = parse(backupInput, body);
    const cur = await getBackupSettings(pool);
    const token = b.bot_token && !b.bot_token.includes('***') ? b.bot_token : b.bot_token === '' ? null : cur.bot_token;
    if (token && !/^\d+:[\w-]{20,}$/.test(token)) throw httpError(400, 'invalid_token', 'Bot token looks wrong (expected 123456:ABC...)');
    const next = { enabled: b.enabled, bot_token: token, chat_id: b.chat_id === undefined ? cur.chat_id : b.chat_id || null, password: b.backup_password || cur.password, hour: b.hour };
    if (next.enabled && (!next.bot_token || !next.chat_id || !next.password)) {
      throw httpError(400, 'backup_incomplete', 'Bot token, chat id and backup password are required to turn it on');
    }
    return next;
  };
  app.get('/backup', backupView);
  app.put('/backup', async (req) => {
    await saveBackupSettings(pool, await mergedBackup(req.body));
    return backupView();
  });
  app.post('/backup/test', async (req) => {
    try {
      await sendTestMessage(await mergedBackup(req.body));
    } catch (e) {
      throw httpError(400, 'telegram_failed', (e as Error).message);
    }
    return { ok: true };
  });
  app.post('/backup/run', async () => {
    try {
      const size = await sendBackup(pool, await getBackupSettings(pool));
      return { ok: true, size, status: await getBackupStatus(pool) };
    } catch (e) {
      throw httpError(400, 'backup_failed', (e as Error).message);
    }
  });

  app.get('/network', proxyView);
  app.put('/network', async (req) => {
    const { url } = parse(proxyUrlInput, req.body);
    if (url && !url.includes('***')) checkedProxy(url);
    let saved: string | null;
    try {
      saved = await setProxySetting(pool, url || null);
    } catch (e) {
      throw httpError(400, 'invalid_proxy', (e as Error).message);
    }
    applyOutboundProxy(saved, (m) => req.log.info(m)); // worker and signer pick it up within 30 s
    return proxyView();
  });
  // Tests the given proxy (or the saved one when `url` is omitted, or direct when it is null/empty).
  app.post('/network/test', async (req) => {
    const { url } = parse(proxyUrlInput, req.body);
    const stored = (await getProxySetting(pool)).url;
    const target = url === undefined || (url && maskProxyUrl(stored) === url.replace(/\/$/, '')) ? stored : checkedProxy(url);
    return { proxy: maskProxyUrl(target), data: await testConnectivity(target) };
  });

  // --- wallets: hot wallets (reported by the signer), funds not yet swept, what is owed to merchants
  // Below this native balance a hot wallet cannot reliably pay sweep gas and payouts.
  const GAS_MIN: Record<string, string> = { tron: '20', bsc: '0.002', ethereum: '0.005', polygon: '1', ton: '0.5' };
  const testnet = (chain: string) =>
    chain === 'tron' ? config.TRON_API_URL.includes('nile') || config.TRON_API_URL.includes('shasta')
    : chain === 'bsc' ? /prebsc|testnet/.test(config.BSC_RPC_URL ?? '')
    : chain === 'ton' ? config.TON_API_URL.includes('testnet')
    : false;
  const explorer = (chain: string, address: string) => {
    const t = testnet(chain);
    switch (chain) {
      case 'tron': return `https://${t ? 'nile.' : ''}tronscan.org/#/address/${address}`;
      case 'bsc': return `https://${t ? 'testnet.' : ''}bscscan.com/address/${address}`;
      case 'ethereum': return `https://etherscan.io/address/${address}`;
      case 'polygon': return `https://polygonscan.com/address/${address}`;
      case 'ton': return `https://${t ? 'testnet.' : ''}tonviewer.com/${address}`;
      default: return null;
    }
  };
  app.get('/wallets', async () => {
    const report = await getWalletReport();
    const { rows: unswept } = await pool.query<{ asset: string; amount: string; addresses: string }>(
      `SELECT asset, SUM(amount) AS amount, COUNT(DISTINCT to_address) AS addresses FROM deposits
       WHERE status = 'confirmed' AND swept_at IS NULL AND chain <> 'ton' GROUP BY asset`,
    );
    const totals = await ledger.platformSummary(pool);
    const active = new Set((await invoices.activeAssets()).map((a) => a.id));
    const wallets = (report?.wallets ?? []).map((w) => {
      const chain = (invoices.registry.chains as Record<string, { name: string } | undefined>)[w.chain];
      const native = invoices.registry.assets.find((a) => a.chain === w.chain && !a.contract);
      const nativeBal = native && w.balances[native.id] != null ? fromBaseUnits(w.balances[native.id]!, native.decimals) : null;
      return {
        chain: w.chain,
        network: chain?.name ?? w.chain,
        testnet: testnet(w.chain),
        address: w.address,
        explorer: explorer(w.chain, w.address),
        cold: w.cold,
        cold_explorer: w.cold ? explorer(w.chain, w.cold) : null,
        gas_asset: native?.id ?? null,
        gas_min: GAS_MIN[w.chain] ?? null,
        low_gas: nativeBal !== null && GAS_MIN[w.chain] !== undefined && Number(nativeBal) < Number(GAS_MIN[w.chain]),
        assets: Object.entries(w.balances).map(([asset, v]) => {
          const t = totals.find((x) => x.asset === asset);
          const u = unswept.find((x) => x.asset === asset);
          return {
            asset,
            active: active.has(asset),
            hot: v === null ? null : fmt(asset, v),
            unswept: fmt(asset, u?.amount ?? '0'),
            unswept_addresses: Number(u?.addresses ?? 0),
            owed: fmt(asset, t?.merchant_balances ?? '0'),
            fees: fmt(asset, t ? (BigInt(t.fees) + BigInt(t.network_fees) + BigInt(t.payout_fees)).toString() : '0'),
          };
        }),
      };
    });
    return { updated_at: report?.updated_at ?? null, wallets };
  });

  // --- merchants
  app.get('/merchants', async () => ({ data: (await listMerchants(pool)).map(merchantView) }));
  app.post('/merchants', async (req, reply) => {
    const exists = await pool.query('SELECT 1 FROM merchants WHERE email = lower($1)', [(req.body as { email?: string })?.email ?? '']);
    if (exists.rows.length) throw httpError(409, 'email_taken', 'Email already registered');
    return reply.code(201).send(await adminCreateMerchant(req.body));
  });
  app.get<{ Params: { id: string } }>('/merchants/:id', async (req) => {
    const m = await getMerchant(pool, req.params.id);
    if (!m) throw httpError(404, 'not_found', 'Merchant not found');
    return {
      merchant: merchantView(m),
      balances: await balancesView(m.id),
      payout_addresses: await payoutAddressesView(m.id),
    };
  });
  app.patch<{ Params: { id: string } }>('/merchants/:id', async (req) => {
    const b = parse(
      z.object({
        fee_percent: z.number().min(0).max(99).optional(),
        settlement_schedule: z.enum(['daily', 'weekly', 'manual']).optional(),
        settlement_weekday: z.number().int().min(0).max(6).optional(),
        is_active: z.boolean().optional(),
        allowed_assets: z.array(z.string()).nullable().optional(),
      }),
      req.body,
    );
    if (b.allowed_assets) {
      for (const a of b.allowed_assets) invoices.asset(a); // throws for unknown / disabled currencies
      if (!b.allowed_assets.length) throw httpError(400, 'no_assets', 'Allow at least one currency');
    }
    if (b.allowed_assets !== undefined) {
      await pool.query('UPDATE merchants SET allowed_assets = $2 WHERE id = $1', [req.params.id, b.allowed_assets]);
    }
    await pool.query(
      `UPDATE merchants SET fee_percent = COALESCE($2, fee_percent), settlement_schedule = COALESCE($3, settlement_schedule),
              settlement_weekday = COALESCE($4, settlement_weekday), is_active = COALESCE($5, is_active)
       WHERE id = $1`,
      [req.params.id, b.fee_percent ?? null, b.settlement_schedule ?? null, b.settlement_weekday ?? null, b.is_active ?? null],
    );
    if (b.is_active === false) await pool.query(`DELETE FROM sessions WHERE role = 'merchant' AND subject_id = $1`, [req.params.id]);
    return { ok: true };
  });

  /** Pays out every asset of one merchant right now, ignoring schedule and minimums. */
  app.post<{ Params: { id: string } }>('/merchants/:id/settle', async (req) => {
    const created = await withTx(async (db) => {
      const { rows } = await db.query<{ asset: string }>('SELECT asset FROM payout_addresses WHERE merchant_id = $1', [req.params.id]);
      const out = [];
      for (const r of rows) {
        const p = await ledger.createPayout(db, req.params.id, r.asset, { respectMinimum: false });
        if (p) out.push(ledger.serializePayout(p));
      }
      return out;
    });
    return { data: created };
  });

  app.post<{ Params: { id: string } }>('/merchants/:id/adjust', async (req) => {
    const b = parse(z.object({ asset: z.string(), amount: z.string().regex(/^-?\d+(\.\d+)?$/), note: z.string().min(3) }), req.body);
    const asset = invoices.asset(b.asset);
    const neg = b.amount.startsWith('-');
    const units = toBaseUnits(neg ? b.amount.slice(1) : b.amount, asset.decimals);
    await ledger.adjust(req.params.id, asset.id, neg ? -units : units, `${b.note} (admin ${req.adminId})`);
    return { ok: true };
  });

  // --- payouts
  app.get('/payouts', async (req) => {
    const { status } = parse(z.object({ status: z.string().optional() }), req.query);
    return { data: await payoutsView(null, status) };
  });
  app.post<{ Params: { id: string } }>('/payouts/:id/approve', async (req) => {
    if (!(await ledger.approvePayout(req.params.id))) throw httpError(409, 'invalid_state', 'Payout is not awaiting approval');
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/payouts/:id/reject', async (req) => {
    const { reason } = parse(z.object({ reason: z.string().default('rejected by admin') }), req.body);
    if (!(await ledger.cancelPayout(req.params.id, 'rejected', reason))) throw httpError(409, 'invalid_state', 'Payout cannot be rejected now');
    return { ok: true };
  });
  app.post('/settlements/run', async () => {
    const created = await ledger.runSettlements();
    return { data: created.map((p) => ledger.serializePayout(p)) };
  });

  // --- invoices & deposits
  app.get('/invoices', async (req) => ({ data: await listInvoices(null, parse(listQuery, req.query)) }));
  app.post<{ Params: { id: string } }>('/invoices/:id/mark-paid', async (req) => invoices.serialize(await invoices.markPaidManually(req.params.id)));
  app.get('/deposits/unmatched', async () => {
    const { rows } = await pool.query<{ asset: string; amount: string }>(
      `SELECT id, chain, asset, tx_hash, from_address, to_address, memo, amount, status, detected_at
       FROM deposits WHERE invoice_id IS NULL ORDER BY detected_at DESC LIMIT 200`,
    );
    return { data: rows.map((r) => ({ ...r, amount: fmt(r.asset, r.amount) })) };
  });
  app.get('/webhooks/failed', async () => {
    const { rows } = await pool.query(
      `SELECT id, merchant_id, event, attempts, last_error, last_status_code, created_at FROM webhook_deliveries
       WHERE status = 'failed' ORDER BY created_at DESC LIMIT 100`,
    );
    return { data: rows };
  });
  app.post<{ Params: { id: string } }>('/webhooks/:id/retry', async (req) => {
    await pool.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });
}

export const adminCreateMerchantSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(10),
  fee_percent: z.number().min(0).max(99).optional(),
  webhook_url: z.string().url().optional(),
});

export async function adminCreateMerchant(body: unknown) {
  const b = parse(adminCreateMerchantSchema, body);
  const m = await createMerchant(pool, { name: b.name, email: b.email, password: b.password, feePercent: b.fee_percent, webhookUrl: b.webhook_url });
  const { key } = await createApiKey(pool, m.id);
  return { merchant: merchantView(m), api_key: key };
}

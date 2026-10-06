import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { findAsset } from '../chains/assets.js';
import { isValidAddress } from '../lib/address.js';
import { fromBaseUnits, toBaseUnits } from '../lib/amount.js';
import { audit } from '../services/audit.js';
import { invoices, ledger } from '../services/index.js';
import {
  authenticateAdmin,
  authenticateMerchant,
  createApiKey,
  createMerchant,
  createSession,
  deleteSession,
  hashPassword,
  listApiKeys,
  revokeApiKey,
  verifyPassword,
} from '../services/merchants.js';
import { isValidIpRule, readCookie, requireMerchantSession, SESSION_COOKIE, sessionCookie } from './auth.js';
import { balancesView, createInvoiceSchema, listInvoices, listQuery, payoutsView, requestPayout } from './merchant-api.js';
import { otpFromRequest, requireOtp, twoFactorRoutes } from './twofactor.js';
import { httpError, parse } from './util.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  role: z.enum(['merchant', 'admin']).default('merchant'),
  otp: z.string().optional(),
});

// Naive in-memory brute-force guard: 10 failed logins per email+IP per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();
function throttled(key: string): boolean {
  const f = failures.get(key);
  return !!f && f.n >= 10 && f.until > Date.now();
}
function fail(key: string) {
  const f = failures.get(key);
  const until = Date.now() + 15 * 60_000;
  failures.set(key, { n: f && f.until > Date.now() ? f.n + 1 : 1, until });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const key = `${body.email.toLowerCase()}|${req.ip}`;
    if (throttled(key)) throw httpError(429, 'too_many_attempts', 'Too many failed attempts, try again later');
    const subject =
      body.role === 'admin'
        ? await authenticateAdmin(pool, body.email, body.password)
        : await authenticateMerchant(pool, body.email, body.password);
    if (!subject) {
      fail(key);
      await audit(pool, { actorType: body.role, action: 'login.failed', details: { email: body.email }, ip: req.ip });
      throw httpError(401, 'invalid_credentials', 'Invalid email or password');
    }
    try {
      await requireOtp(body.role, subject.id, body.otp ?? otpFromRequest(req));
    } catch (err) {
      if ((err as { code?: string }).code === 'otp_invalid') fail(key);
      throw err;
    }
    failures.delete(key);
    await audit(pool, {
      actorType: body.role,
      actorId: subject.id,
      merchantId: body.role === 'merchant' ? subject.id : null,
      action: 'login',
      ip: req.ip,
    });
    const token = await createSession(pool, body.role, subject.id);
    reply.header('set-cookie', sessionCookie(token, config.SESSION_TTL_HOURS * 3600));
    return { ok: true, role: body.role };
  });

  app.post('/logout', async (req, reply) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await deleteSession(pool, token);
    reply.header('set-cookie', sessionCookie('', 0));
    return { ok: true };
  });

  app.post('/signup', async (req, reply) => {
    if (!config.ALLOW_MERCHANT_SIGNUP) throw httpError(403, 'signup_disabled', 'Self sign-up is disabled');
    const body = parse(z.object({ name: z.string().min(2).max(100), email: z.string().email(), password: z.string().min(10) }), req.body);
    const exists = await pool.query('SELECT 1 FROM merchants WHERE email = lower($1)', [body.email]);
    if (exists.rows.length) throw httpError(409, 'email_taken', 'Email already registered');
    const m = await createMerchant(pool, body);
    const token = await createSession(pool, 'merchant', m.id);
    reply.header('set-cookie', sessionCookie(token, config.SESSION_TTL_HOURS * 3600));
    return { ok: true };
  });
}

const settingsSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  webhook_url: z.string().url().nullable().optional(),
  settlement_schedule: z.enum(['daily', 'weekly', 'manual']).optional(),
  settlement_weekday: z.number().int().min(0).max(6).optional(),
  fee_payer: z.enum(['merchant', 'customer']).optional(),
});

const payoutAddressSchema = z.object({
  asset: z.string(),
  address: z.string().min(10).max(128),
  min_amount: z.string().default('0'),
});

const ipListSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    const list = (Array.isArray(v) ? v : (v ?? '').split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean);
    return list.length ? list : null;
  });

export function merchantView(m: NonNullable<import('fastify').FastifyRequest['merchant']>) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    webhook_url: m.webhook_url,
    fee_percent: m.fee_percent,
    settlement_schedule: m.settlement_schedule,
    settlement_weekday: m.settlement_weekday,
    fee_payer: m.fee_payer,
    totp_enabled: m.totp_enabled,
    allowed_assets: m.allowed_assets,
    last_settled_at: m.last_settled_at,
    is_active: m.is_active,
    created_at: m.created_at,
  };
}

export async function payoutAddressesView(merchantId: string) {
  const { rows } = await pool.query<{ asset: string; address: string; min_amount: string; updated_at: Date; locked_until: Date | null }>(
    'SELECT asset, address, min_amount, updated_at, locked_until FROM payout_addresses WHERE merchant_id = $1 ORDER BY asset',
    [merchantId],
  );
  return rows.map((r) => {
    const a = findAsset(invoices.registry, r.asset);
    return { ...r, min_amount: a ? fromBaseUnits(r.min_amount, a.decimals) : r.min_amount };
  });
}

/** Merchant dashboard API (cookie session). */
export async function panelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireMerchantSession);
  await app.register(twoFactorRoutes('merchant', (req) => req.merchant!.id));
  const otp = (req: import('fastify').FastifyRequest) => requireOtp('merchant', req.merchant!.id, otpFromRequest(req));
  const log = (req: import('fastify').FastifyRequest, action: string, details?: Record<string, unknown>) =>
    audit(pool, { actorType: 'merchant', actorId: req.merchant!.id, merchantId: req.merchant!.id, action, details, ip: req.ip });

  app.get('/me', async (req) => ({
    merchant: merchantView(req.merchant!),
    assets: await invoices.merchantAssets(req.merchant!.id),
    asset_settings: await ledger.settings.view(pool, (await invoices.merchantAssets(req.merchant!.id)).map((x) => x.id)),
    settlement_hour_utc: config.SETTLEMENT_HOUR_UTC,
  }));

  app.patch('/settings', async (req) => {
    const b = parse(settingsSchema, req.body);
    if (b.webhook_url !== undefined && b.webhook_url !== req.merchant!.webhook_url) await otp(req);
    await pool.query(
      `UPDATE merchants SET name = COALESCE($2, name),
              webhook_url = CASE WHEN $3::boolean THEN $4 ELSE webhook_url END,
              settlement_schedule = COALESCE($5, settlement_schedule),
              settlement_weekday = COALESCE($6, settlement_weekday),
              fee_payer = COALESCE($7, fee_payer)
       WHERE id = $1`,
      [req.merchant!.id, b.name ?? null, b.webhook_url !== undefined, b.webhook_url ?? null, b.settlement_schedule ?? null, b.settlement_weekday ?? null, b.fee_payer ?? null],
    );
    await log(req, 'settings.updated', b);
    return { ok: true };
  });

  app.get('/webhook-secret', async (req) => {
    await otp(req);
    return { webhook_secret: req.merchant!.webhook_secret };
  });
  app.post('/webhook-secret/rotate', async (req) => {
    await otp(req);
    await log(req, 'webhook_secret.rotated');
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    await pool.query('UPDATE merchants SET webhook_secret = $2 WHERE id = $1', [req.merchant!.id, secret]);
    return { webhook_secret: secret };
  });

  app.post('/password', async (req) => {
    const b = parse(z.object({ current: z.string(), next: z.string().min(10) }), req.body);
    const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM merchants WHERE id = $1', [req.merchant!.id]);
    if (!(await verifyPassword(b.current, rows[0]!.password_hash))) throw httpError(400, 'wrong_password', 'Current password is wrong');
    await otp(req);
    await log(req, 'password.changed');
    await pool.query('UPDATE merchants SET password_hash = $2 WHERE id = $1', [req.merchant!.id, await hashPassword(b.next)]);
    await pool.query(`DELETE FROM sessions WHERE role = 'merchant' AND subject_id = $1`, [req.merchant!.id]);
    return { ok: true };
  });

  // --- invoices
  app.get('/invoices', async (req) => ({ data: await listInvoices(req.merchant!.id, parse(listQuery, req.query)) }));
  app.post('/invoices', async (req) => invoices.serialize(await invoices.create(req.merchant!.id, parse(createInvoiceSchema, req.body)), []));
  app.get<{ Params: { id: string } }>('/invoices/:id', async (req) => {
    const inv = await invoices.get(pool, req.params.id, req.merchant!.id);
    if (!inv) throw httpError(404, 'not_found', 'Invoice not found');
    return invoices.serialize(inv, await invoices.deposits(pool, inv.id));
  });
  app.post<{ Params: { id: string } }>('/invoices/:id/cancel', async (req) => invoices.serialize(await invoices.cancel(req.params.id, req.merchant!.id)));

  // --- money
  app.get('/balances', async (req) => ({ data: await balancesView(req.merchant!.id) }));
  app.get('/ledger', async (req) => {
    const rows = (await ledger.entries(pool, req.merchant!.id, 200)) as { asset: string; amount: string }[];
    return {
      data: rows.map((r) => {
        const a = findAsset(invoices.registry, r.asset);
        return { ...r, amount: a ? fromBaseUnits(r.amount, a.decimals) : r.amount };
      }),
    };
  });
  app.get('/payouts', async (req) => ({ data: await payoutsView(req.merchant!.id) }));
  app.post('/payouts', async (req) => {
    const { asset } = parse(z.object({ asset: z.string() }), req.body);
    const p = await requestPayout(req.merchant!.id, asset);
    if (!p) throw httpError(409, 'nothing_to_pay', 'No balance above the network fee, or no payout address for this asset');
    await log(req, 'payout.requested', { asset, payout: p.id });
    return p;
  });

  app.get('/payout-addresses', async (req) => ({ data: await payoutAddressesView(req.merchant!.id) }));
  app.put('/payout-addresses', async (req) => {
    const b = parse(payoutAddressSchema, req.body);
    const asset = invoices.asset(b.asset);
    const family = invoices.registry.chains[asset.chain].family;
    if (!isValidAddress(family, b.address.trim())) throw httpError(400, 'invalid_address', `Not a valid ${asset.chain} address`);
    let min: bigint;
    try {
      min = toBaseUnits(b.min_amount, asset.decimals);
    } catch {
      throw httpError(400, 'invalid_amount', 'Invalid min_amount');
    }
    const address = b.address.trim();
    const { rows: cur } = await pool.query<{ address: string }>(
      'SELECT address FROM payout_addresses WHERE merchant_id = $1 AND asset = $2',
      [req.merchant!.id, asset.id],
    );
    const changing = cur[0] ? cur[0].address !== address : await hadAddressBefore(req.merchant!.id, asset.id);
    if (changing) await otp(req);
    // A new destination only receives payouts after the hold, so a hijacked account cannot drain funds at once.
    await pool.query(
      `INSERT INTO payout_addresses (merchant_id, asset, address, min_amount, locked_until)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() + make_interval(hours => $6) END)
       ON CONFLICT (merchant_id, asset) DO UPDATE SET address = EXCLUDED.address, min_amount = EXCLUDED.min_amount,
         locked_until = CASE WHEN $5 THEN EXCLUDED.locked_until ELSE payout_addresses.locked_until END, updated_at = now()`,
      [req.merchant!.id, asset.id, address, min.toString(), changing, config.PAYOUT_ADDRESS_HOLD_HOURS],
    );
    await log(req, 'payout_address.set', { asset: asset.id, address, previous: cur[0]?.address ?? null, hold: changing });
    return { ok: true, held_hours: changing ? config.PAYOUT_ADDRESS_HOLD_HOURS : 0 };
  });
  app.delete<{ Params: { asset: string } }>('/payout-addresses/:asset', async (req) => {
    await otp(req);
    const asset = req.params.asset.toUpperCase();
    await pool.query('DELETE FROM payout_addresses WHERE merchant_id = $1 AND asset = $2', [req.merchant!.id, asset]);
    await log(req, 'payout_address.deleted', { asset });
    return { ok: true };
  });

  // --- API keys
  app.get('/api-keys', async (req) => ({ data: await listApiKeys(pool, req.merchant!.id) }));
  app.post('/api-keys', async (req) => {
    const b = parse(z.object({ label: z.string().min(1).max(50).default('default'), allowed_ips: ipListSchema }), req.body);
    if (b.allowed_ips?.some((ip) => !isValidIpRule(ip))) throw httpError(400, 'invalid_ip', 'Use IPv4/IPv6 addresses or IPv4 CIDR ranges');
    await otp(req);
    const { key, row } = await createApiKey(pool, req.merchant!.id, b.label, b.allowed_ips);
    await log(req, 'api_key.created', { label: b.label, prefix: row.key_prefix, allowed_ips: b.allowed_ips });
    return { ...row, key };
  });
  app.patch<{ Params: { id: string } }>('/api-keys/:id', async (req) => {
    const b = parse(z.object({ allowed_ips: ipListSchema }), req.body);
    if (b.allowed_ips?.some((ip) => !isValidIpRule(ip))) throw httpError(400, 'invalid_ip', 'Use IPv4/IPv6 addresses or IPv4 CIDR ranges');
    await otp(req);
    await pool.query('UPDATE api_keys SET allowed_ips = $3 WHERE id = $1 AND merchant_id = $2', [req.params.id, req.merchant!.id, b.allowed_ips]);
    await log(req, 'api_key.ips_changed', { key: req.params.id, allowed_ips: b.allowed_ips });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req) => {
    const ok = await revokeApiKey(pool, req.merchant!.id, req.params.id);
    await log(req, 'api_key.revoked', { key: req.params.id });
    return { ok };
  });

  app.get('/stats', async (req) => ({ data: await dailyStats(req.merchant!.id, parse(statsQuery, req.query).days) }));

  app.get('/audit', async (req) => ({ data: await (await import('../services/audit.js')).auditList(pool, { merchantId: req.merchant!.id, limit: 100 }) }));
}

async function hadAddressBefore(merchantId: string, asset: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM audit_log WHERE merchant_id = $1 AND action = 'payout_address.set' AND details->>'asset' = $2 LIMIT 1`,
    [merchantId, asset],
  );
  return rows.length > 0;
}

export const statsQuery = z.object({ days: z.coerce.number().int().min(7).max(90).default(14) });

/** Paid invoices per UTC day (count, and volume of USD/USDT-priced invoices), zero-filled. */
export async function dailyStats(merchantId: string | null, days: number) {
  const { rows } = await pool.query<{ day: string; paid: string; volume: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            COUNT(i.id) AS paid,
            COALESCE(SUM(i.price_amount) FILTER (WHERE i.price_currency IN ('USD', 'USDT')), 0) AS volume
     FROM generate_series((now() AT TIME ZONE 'utc')::date - ($1::int - 1), (now() AT TIME ZONE 'utc')::date, interval '1 day') d
     LEFT JOIN invoices i ON i.status = 'paid' AND (i.paid_at AT TIME ZONE 'utc')::date = d::date
       AND ($2::uuid IS NULL OR i.merchant_id = $2::uuid)
     GROUP BY d ORDER BY d`,
    [days, merchantId],
  );
  return rows.map((r) => ({ day: r.day, paid: Number(r.paid), volume: Number(r.volume) }));
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { findAsset } from '../chains/assets.js';
import { fromBaseUnits, toBaseUnits } from '../lib/amount.js';
import { invoices, ledger } from '../services/index.js';
import { createApiKey, createMerchant, getMerchant, listMerchants } from '../services/merchants.js';
import { requireAdminSession } from './auth.js';
import { balancesView, listInvoices, listQuery, payoutsView } from './merchant-api.js';
import { merchantView, payoutAddressesView } from './panel.js';
import { httpError, parse } from './util.js';

const fmt = (asset: string, v: string) => {
  const a = findAsset(invoices.registry, asset);
  return a ? fromBaseUnits(v, a.decimals) : v;
};

/** Platform operator API (cookie session, role=admin). */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdminSession);

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
  app.put('/asset-settings', async (req) => {
    const b = parse(
      z.object({ asset: z.string(), sweep_threshold: z.string().regex(/^\d+(\.\d+)?$/), payout_fee: z.string().regex(/^\d+(\.\d+)?$/) }),
      req.body,
    );
    const asset = invoices.asset(b.asset);
    let threshold: bigint, fee: bigint;
    try {
      threshold = toBaseUnits(b.sweep_threshold, asset.decimals);
      fee = toBaseUnits(b.payout_fee, asset.decimals);
    } catch (e) {
      throw httpError(400, 'invalid_amount', (e as Error).message);
    }
    await ledger.settings.set(pool, asset.id, threshold, fee);
    return { ok: true };
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
      }),
      req.body,
    );
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

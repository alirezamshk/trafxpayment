import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { fromBaseUnits } from '../lib/amount.js';
import { findAsset } from '../chains/assets.js';
import { invoices, ledger } from '../services/index.js';
import type { InvoiceRow } from '../services/invoices.js';
import type { PayoutRow } from '../services/ledger.js';
import { requireApiKey } from './auth.js';
import { httpError, parse } from './util.js';

export const createInvoiceSchema = z.object({
  price_amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  price_currency: z.string().default('USD'),
  asset: z.string().optional(),
  order_id: z.string().max(128).optional(),
  description: z.string().max(500).optional(),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expires_in_minutes: z.number().int().optional(),
  customer_id: z.string().max(128).optional(),
  fee_paid_by: z.enum(['merchant', 'customer']).optional(),
});

export const listQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().datetime().optional(),
});

export async function listInvoices(merchantId: string | null, q: z.infer<typeof listQuery>) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (merchantId) where.push(`merchant_id = $${params.push(merchantId)}`);
  if (q.status) where.push(`status = $${params.push(q.status)}`);
  if (q.before) where.push(`created_at < $${params.push(q.before)}`);
  const { rows } = await pool.query<InvoiceRow>(
    `SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC LIMIT $${params.push(q.limit)}`,
    params,
  );
  return rows.map((r) => invoices.serialize(r));
}

export async function balancesView(merchantId: string) {
  const rows = await ledger.balances(pool, merchantId);
  return rows.map((b) => {
    const a = findAsset(invoices.registry, b.asset);
    return { asset: b.asset, balance: a ? fromBaseUnits(b.balance, a.decimals) : b.balance.toString() };
  });
}

export async function payoutsView(merchantId: string | null, status?: string) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (merchantId) where.push(`merchant_id = $${params.push(merchantId)}`);
  if (status) where.push(`status = $${params.push(status)}`);
  const { rows } = await pool.query<PayoutRow & { merchant_name?: string }>(
    `SELECT p.*, m.name AS merchant_name FROM payouts p JOIN merchants m ON m.id = p.merchant_id
     ${where.length ? 'WHERE ' + where.map((w) => 'p.' + w).join(' AND ') : ''}
     ORDER BY p.created_at DESC LIMIT 200`,
    params,
  );
  return rows.map((p) => ({ ...ledger.serializePayout(p), merchant_id: p.merchant_id, merchant_name: p.merchant_name }));
}

export async function requestPayout(merchantId: string, asset: string) {
  const { rows } = await pool.query<{ locked_until: Date | null }>(
    'SELECT locked_until FROM payout_addresses WHERE merchant_id = $1 AND asset = $2',
    [merchantId, asset.toUpperCase()],
  );
  const until = rows[0]?.locked_until;
  if (until && until > new Date()) {
    throw httpError(409, 'address_on_hold', `The payout address was changed recently; payouts resume at ${until.toISOString()}`);
  }
  const payout = await withTx((db) => ledger.createPayout(db, merchantId, asset.toUpperCase(), { respectMinimum: false }));
  return payout ? ledger.serializePayout(payout) : null;
}

/** Server-to-server API for merchants' own websites/panels. */
export async function merchantApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireApiKey);

  app.post('/invoices', async (req, reply) => {
    const body = parse(createInvoiceSchema, req.body);
    const inv = await invoices.create(req.merchant!.id, body);
    return reply.code(201).send(invoices.serialize(inv, []));
  });

  app.get('/invoices', async (req) => ({ data: await listInvoices(req.merchant!.id, parse(listQuery, req.query)) }));

  app.get<{ Params: { id: string } }>('/invoices/:id', async (req, reply) => {
    const inv = await invoices.get(pool, req.params.id, req.merchant!.id);
    if (!inv) return reply.code(404).send({ error: { code: 'not_found', message: 'Invoice not found' } });
    return invoices.serialize(inv, await invoices.deposits(pool, inv.id));
  });

  app.post<{ Params: { id: string } }>('/invoices/:id/cancel', async (req) =>
    invoices.serialize(await invoices.cancel(req.params.id, req.merchant!.id)),
  );

  app.get('/balances', async (req) => ({ data: await balancesView(req.merchant!.id) }));
  app.get('/payouts', async (req) => ({ data: await payoutsView(req.merchant!.id) }));
  app.post('/payouts', async (req, reply) => {
    const { asset } = parse(z.object({ asset: z.string() }), req.body);
    const p = await requestPayout(req.merchant!.id, asset);
    if (!p) return reply.code(409).send({ error: { code: 'nothing_to_pay', message: 'No balance or no payout address for this asset' } });
    return reply.code(201).send(p);
  });
}

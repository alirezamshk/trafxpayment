import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { findAsset } from '../chains/assets.js';
import { invoices } from '../services/index.js';
import { InvoiceError, type InvoiceRow } from '../services/invoices.js';
import { adminRoutes } from './admin.js';
import { merchantApiRoutes } from './merchant-api.js';
import { authRoutes, panelRoutes } from './panel.js';
import { parse } from './util.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), 'utf8');

/** Wallet deep-link / QR payload for the selected asset. */
export function paymentUri(inv: InvoiceRow): string | null {
  if (!inv.address || !inv.asset || !inv.pay_amount) return null;
  const asset = findAsset(invoices.registry, inv.asset);
  if (!asset) return null;
  if (asset.chain === 'ton') {
    const p = new URLSearchParams({ amount: inv.pay_amount, text: inv.memo ?? '' });
    if (asset.contract) p.set('jetton', asset.contract);
    return `ton://transfer/${inv.address}?${p.toString()}`;
  }
  return inv.address;
}

async function publicView(inv: InvoiceRow) {
  const s = invoices.serialize(inv);
  const uri = paymentUri(inv);
  const asset = inv.asset ? findAsset(invoices.registry, inv.asset) : undefined;
  const { rows: m } = await pool.query<{ name: string }>('SELECT name FROM merchants WHERE id = $1', [inv.merchant_id]);
  return {
    id: s.id,
    merchant_name: m[0]?.name,
    description: s.description,
    status: s.status,
    price_amount: s.price_amount,
    price_currency: s.price_currency,
    asset: s.asset,
    asset_symbol: asset?.symbol ?? null,
    network: s.network,
    network_name: inv.chain ? invoices.registry.chains[inv.chain as keyof typeof invoices.registry.chains]?.name : null,
    confirmations_required: inv.chain ? invoices.registry.chains[inv.chain as keyof typeof invoices.registry.chains]?.confirmations : null,
    token_contract: asset?.contract ?? null,
    address: s.address,
    memo: s.memo,
    permanent_address: !!inv.customer_id && !inv.memo,
    pay_amount: s.pay_amount,
    amount_received: s.amount_received,
    amount_pending: s.amount_pending,
    expires_at: s.expires_at,
    success_url: inv.status === 'paid' ? s.success_url : null,
    cancel_url: s.cancel_url,
    payment_uri: uri,
    qr: uri ? await QRCode.toDataURL(uri, { margin: 1, width: 240 }) : null,
    assets: inv.asset ? undefined : await invoices.payableAssets(inv),
    network_fee: inv.fee_paid_by === 'customer' ? s.network_fee : null,
  };
}

export async function buildServer() {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: true, bodyLimit: 64 * 1024 });

  app.setErrorHandler((err: FastifyError | InvoiceError, req, reply) => {
    if (err instanceof InvoiceError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    const code = (err as FastifyError).statusCode;
    if (code && code >= 400 && code < 500) {
      return reply.code(code).send({ error: { code: (err as FastifyError).code ?? 'bad_request', message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // ---- public
  app.get('/v1/assets', async () => ({ data: invoices.availableAssets() }));

  app.get<{ Params: { id: string } }>('/api/public/invoices/:id', async (req, reply) => {
    const inv = await invoices.get(pool, req.params.id);
    if (!inv) return reply.code(404).send({ error: { code: 'not_found', message: 'Invoice not found' } });
    return publicView(inv);
  });
  app.post<{ Params: { id: string } }>('/api/public/invoices/:id/asset', async (req) => {
    const { asset } = parse(z.object({ asset: z.string() }), req.body);
    return publicView(await invoices.selectAsset(req.params.id, asset));
  });

  // ---- APIs
  await app.register(merchantApiRoutes, { prefix: '/v1' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(panelRoutes, { prefix: '/api/panel' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // ---- pages
  const pages: Record<string, string> = { '/pay/:id': 'pay.html', '/panel': 'panel.html', '/admin': 'admin.html', '/': 'index.html' };
  const cache = new Map<string, string>();
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, async (_req, reply) => {
      const html = config.NODE_ENV === 'production' ? (cache.get(file) ?? cache.set(file, page(file)).get(file)!) : page(file);
      return reply.type('text/html; charset=utf-8').send(html);
    });
  }
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.get('/assets/app.css', async (_req, reply) => reply.type('text/css').send(page('app.css')));
  app.get('/assets/app.js', async (_req, reply) => reply.type('application/javascript').send(page('app.js')));

  return app;
}

import { getAddress, zeroPadValue, type Log } from 'ethers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { migrate } from '../src/bin/migrate.js';
import { registry } from '../src/context.js';
import { pool, withTx } from '../src/db.js';
import { invoices, ledger } from '../src/services/index.js';
import { createApiKey, createAdmin, createMerchant } from '../src/services/merchants.js';
import { EvmWatcher, TRANSFER_TOPIC, type EvmRpc } from '../src/watchers/evm.js';
import type { Logger } from '../src/watchers/types.js';
import { WebhookDispatcher } from '../src/workers/webhook-dispatcher.js';
import { verifySignature } from '../src/services/webhooks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} };

async function reset() {
  await migrate();
  const { rows } = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  await pool.query(`TRUNCATE ${rows.map((r) => r.tablename).join(', ')} CASCADE`);
}

async function merchant(fee = 2) {
  return createMerchant(pool, { name: 'Shop', email: `m${Math.random()}@x.io`, password: 'password1234', feePercent: fee, webhookUrl: 'https://shop.example/hook' });
}

async function events(invoiceId: string) {
  const { rows } = await pool.query<{ event: string }>('SELECT event FROM webhook_deliveries WHERE invoice_id = $1 ORDER BY created_at', [invoiceId]);
  return rows.map((r) => r.event);
}

beforeEach(reset);
afterAll(() => pool.end());

describe('invoice lifecycle + ledger', () => {
  it('detects, confirms, credits net of fee, settles and refunds a rejected payout', async () => {
    const m = await merchant(2);
    const inv = await invoices.create(m.id, { price_amount: '100', price_currency: 'USD', asset: 'USDT_TRC20', order_id: 'A1' });
    expect(inv.pay_amount).toBe('100000000');
    expect(inv.address).toMatch(/^T/);
    await expect(invoices.create(m.id, { price_amount: '1', price_currency: 'USD', order_id: 'A1' })).rejects.toThrow(/already exists/);

    const dep = { invoiceId: inv.id, chain: 'tron', asset: 'USDT_TRC20', txHash: 'tx1', eventIndex: 'trc20:0', from: 'TX', to: inv.address! };
    expect(await invoices.recordDeposit({ ...dep, amount: 100_000_000n })).toBe(true);
    expect(await invoices.recordDeposit({ ...dep, amount: 100_000_000n })).toBe(false); // idempotent
    expect((await invoices.get(pool, inv.id))!.status).toBe('confirming');

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM deposits WHERE tx_hash = $1', ['tx1']);
    await invoices.updateDepositConfirmations(rows[0]!.id, 19, 'confirmed');
    const paid = (await invoices.get(pool, inv.id))!;
    expect(paid.status).toBe('paid');
    expect(paid.fee_amount).toBe('2000000');
    expect(await events(inv.id)).toEqual(['invoice.confirming', 'invoice.paid']);
    expect((await ledger.balances(pool, m.id))[0]).toEqual({ asset: 'USDT_TRC20', balance: 98_000_000n });

    // A late top-up after `paid` is credited as well (minus fee).
    await invoices.recordDeposit({ ...dep, txHash: 'tx2', amount: 10_000_000n, confirmed: true });
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(98_000_000n + 9_800_000n);

    // Settlement: nothing without a payout address, then one payout for the full balance.
    expect(await ledger.runSettlements(new Date(Date.now() + 2 * 86400_000))).toHaveLength(0);
    await pool.query(`UPDATE merchants SET last_settled_at = NULL WHERE id = $1`, [m.id]);
    await pool.query(`INSERT INTO payout_addresses (merchant_id, asset, address) VALUES ($1, 'USDT_TRC20', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')`, [m.id]);
    const payouts = await ledger.runSettlements(new Date(Date.now() + 2 * 86400_000));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.amount).toBe('107800000');
    expect(payouts[0]!.status).toBe('pending_approval');
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(0n);
    // Not due twice in the same period.
    expect(await ledger.runSettlements(new Date(Date.now() + 2 * 86400_000))).toHaveLength(0);

    expect(await ledger.cancelPayout(payouts[0]!.id, 'rejected', 'test')).toBe(true);
    expect(await ledger.cancelPayout(payouts[0]!.id, 'rejected', 'again')).toBe(false);
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(107_800_000n);
    const summary = await ledger.platformSummary(pool);
    expect(summary[0]!.fees).toBe('2200000');
  });

  it('handles partial payment, orphaned deposits, expiry and manual acceptance', async () => {
    const m = await merchant(1);
    const inv = await invoices.create(m.id, { price_amount: '50', price_currency: 'USD', asset: 'USDT_TRC20' });
    const dep = { invoiceId: inv.id, chain: 'tron', asset: 'USDT_TRC20', from: 'TX', to: inv.address! };
    await invoices.recordDeposit({ ...dep, txHash: 'p1', eventIndex: '0', amount: 20_000_000n });
    expect((await invoices.get(pool, inv.id))!.status).toBe('partially_paid');

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM deposits WHERE tx_hash = 'p1'`);
    await invoices.updateDepositConfirmations(rows[0]!.id, 0, 'orphaned');
    expect((await invoices.get(pool, inv.id))!.status).toBe('pending');

    await invoices.recordDeposit({ ...dep, txHash: 'p2', eventIndex: '0', amount: 30_000_000n, confirmed: true });
    await pool.query(`UPDATE invoices SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.id]);
    await invoices.expireDue();
    expect((await invoices.get(pool, inv.id))!.status).toBe('partially_paid');
    expect((await ledger.balances(pool, m.id))).toEqual([]);

    const accepted = await invoices.markPaidManually(inv.id);
    expect(accepted.status).toBe('paid');
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(30_000_000n - 300_000n);
  });

  it('expires untouched invoices and lets merchants cancel them', async () => {
    const m = await merchant();
    const a = await invoices.create(m.id, { price_amount: '5', price_currency: 'USD' });
    expect(a.asset).toBeNull();
    await pool.query(`UPDATE invoices SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
    expect(await invoices.expireDue()).toBe(1);
    expect((await invoices.get(pool, a.id))!.status).toBe('expired');
    await expect(invoices.selectAsset(a.id, 'USDT_TRC20')).rejects.toThrow(/no longer payable/);

    const b = await invoices.create(m.id, { price_amount: '5', price_currency: 'USD' });
    expect((await invoices.cancel(b.id, m.id)).status).toBe('cancelled');
  });

  it('assigns unique HD addresses, shared across EVM chains, and TON memos', async () => {
    const m = await merchant();
    const e1 = await invoices.create(m.id, { price_amount: '1', price_currency: 'ETH', asset: 'ETH' });
    const e2 = await invoices.create(m.id, { price_amount: '1', price_currency: 'USDT', asset: 'USDT_BEP20' });
    expect(e1.derivation_index).toBe('0');
    expect(e2.derivation_index).toBe('1');
    expect(e1.address).not.toBe(e2.address);
    expect(e1.pay_amount).toBe('1000000000000000000');
    expect(e2.pay_amount).toBe('1000000000000000000'); // BEP20 USDT has 18 decimals

    const t = await invoices.create(m.id, { price_amount: '3', price_currency: 'USD', asset: 'USDT_TON' });
    expect(t.address).toBe(process.env.TON_TREASURY_ADDRESS);
    expect(t.memo).toMatch(/^[A-Z2-9]{10}$/);
  });
});

describe('EVM watcher (stubbed RPC)', () => {
  it('detects a USDT transfer, waits for confirmations, re-checks the receipt', async () => {
    const m = await merchant(1);
    const inv = await invoices.create(m.id, { price_amount: '25', price_currency: 'USD', asset: 'USDT_ERC20' });
    const usdt = registry.assets.find((a) => a.id === 'USDT_ERC20')!;
    let head = 1000;
    let receipt: { status: number; blockNumber: number; blockHash: string } | null = { status: 1, blockNumber: 995, blockHash: '0xb995' };
    const rpc: EvmRpc = {
      getBlockNumber: async () => head,
      getLogs: async (f) =>
        f.fromBlock <= 995 && f.toBlock >= 995
          ? [{ address: usdt.contract!, topics: [TRANSFER_TOPIC, zeroPadValue('0x2222222222222222222222222222222222222222', 32), zeroPadValue(inv.address!, 32)], data: '0x' + (25_000_000).toString(16).padStart(64, '0'), blockNumber: 995, blockHash: '0xb995', transactionHash: '0xdead', index: 1, removed: false } as unknown as Log]
          : [],
      getBlockTransactions: async () => [],
      getReceipt: async () => receipt,
    };
    const watcher = new EvmWatcher(registry.chains.ethereum, registry.assets.filter((a) => a.chain === 'ethereum'), invoices, rpc, silent);
    await watcher.tick();
    let cur = (await invoices.get(pool, inv.id))!;
    expect(cur.status).toBe('confirming');
    const { rows } = await pool.query<{ from_address: string; confirmations: number }>('SELECT from_address, confirmations FROM deposits');
    expect(rows[0]!.from_address).toBe(getAddress('0x2222222222222222222222222222222222222222'));

    head = 995 + registry.chains.ethereum.confirmations - 1;
    await watcher.tick();
    expect((await invoices.get(pool, inv.id))!.status).toBe('paid');
    cur = (await invoices.get(pool, inv.id))!;
    expect(cur.amount_received).toBe('25000000');

    // A second invoice whose tx reverts is orphaned.
    const inv2 = await invoices.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_ERC20' });
    await pool.query('INSERT INTO deposits (invoice_id, chain, asset, tx_hash, to_address, amount, block_number) VALUES ($1, $2, $3, $4, $5, $6, $7)', [inv2.id, 'ethereum', 'USDT_ERC20', '0xbad', inv2.address, '1000000', 990]);
    receipt = { status: 0, blockNumber: 990, blockHash: '0xb990' };
    head += 5;
    await watcher.tick();
    const { rows: d2 } = await pool.query<{ status: string }>(`SELECT status FROM deposits WHERE tx_hash = '0xbad'`);
    expect(d2[0]!.status).toBe('orphaned');
  });
});

describe('HTTP API', () => {
  it('serves the merchant API, panel and admin flows', async () => {
    const app = await buildServer();
    const m = await merchant(1.5);
    const { key } = await createApiKey(pool, m.id);
    const auth = { authorization: `Bearer ${key}` };

    expect((await app.inject({ method: 'POST', url: '/v1/invoices', payload: { price_amount: '1', price_currency: 'USD' } })).statusCode).toBe(401);

    const created = await app.inject({ method: 'POST', url: '/v1/invoices', headers: auth, payload: { price_amount: '12.5', price_currency: 'USD', order_id: 'O-9' } });
    expect(created.statusCode).toBe(201);
    const inv = created.json();
    expect(inv.payment_url).toContain(`/pay/${inv.id}`);
    expect(inv.asset).toBeNull();

    const pub = (await app.inject({ method: 'GET', url: `/api/public/invoices/${inv.id}` })).json();
    expect(pub.assets.map((a: { id: string }) => a.id)).toContain('USDT_TRC20');
    expect(pub.metadata).toBeUndefined();

    const sel = await app.inject({ method: 'POST', url: `/api/public/invoices/${inv.id}/asset`, payload: { asset: 'USDT_TRC20' } });
    expect(sel.statusCode).toBe(200);
    expect(sel.json().pay_amount).toBe('12.5');
    expect(sel.json().qr).toMatch(/^data:image\/png/);
    expect((await app.inject({ method: 'POST', url: `/api/public/invoices/${inv.id}/asset`, payload: { asset: 'TRX' } })).statusCode).toBe(409);

    const bad = await app.inject({ method: 'POST', url: '/v1/invoices', headers: auth, payload: { price_amount: '-3', price_currency: 'USD' } });
    expect(bad.statusCode).toBe(400);

    // Another merchant cannot read it.
    const other = await merchant();
    const { key: key2 } = await createApiKey(pool, other.id);
    expect((await app.inject({ method: 'GET', url: `/v1/invoices/${inv.id}`, headers: { authorization: `Bearer ${key2}` } })).statusCode).toBe(404);

    // Panel login + payout address validation
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.email, password: 'password1234' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/api/panel/me', headers: { cookie } });
    expect(me.json().merchant.fee_percent).toBe('1.500');
    const badAddr = await app.inject({ method: 'PUT', url: '/api/panel/payout-addresses', headers: { cookie }, payload: { asset: 'USDT_TRC20', address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' } });
    expect(badAddr.statusCode).toBe(400);
    const goodAddr = await app.inject({ method: 'PUT', url: '/api/panel/payout-addresses', headers: { cookie }, payload: { asset: 'USDT_TRC20', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', min_amount: '10' } });
    expect(goodAddr.statusCode).toBe(200);
    // CSRF guard: form-encoded mutation is refused
    const csrf = await app.inject({ method: 'POST', url: '/api/panel/api-keys', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'label=x' });
    expect(csrf.statusCode).toBe(415);
    // merchant session cannot reach admin
    expect((await app.inject({ method: 'GET', url: '/api/admin/summary', headers: { cookie } })).statusCode).toBe(401);

    await createAdmin(pool, 'root@x.io', 'adminpassword1');
    const al = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'root@x.io', password: 'adminpassword1', role: 'admin' } });
    const acookie = String(al.headers['set-cookie']).split(';')[0]!;
    const fee = await app.inject({ method: 'PATCH', url: `/api/admin/merchants/${m.id}`, headers: { cookie: acookie }, payload: { fee_percent: 3 } });
    expect(fee.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/summary', headers: { cookie: acookie } })).statusCode).toBe(200);

    expect((await app.inject({ method: 'GET', url: `/pay/${inv.id}` })).headers['content-type']).toContain('text/html');
    await app.close();
  });
});

describe('webhook dispatcher', () => {
  it('delivers signed payloads and retries failures', async () => {
    const m = await merchant();
    const inv = await invoices.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_TRC20' });
    await invoices.cancel(inv.id);
    const calls: { headers: Record<string, string>; body: string }[] = [];
    let ok = false;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response('', { status: ok ? 200 : 500 });
    }) as typeof fetch;
    const d = new WebhookDispatcher(silent, fakeFetch);
    await d.tick();
    const { rows } = await pool.query<{ status: string; attempts: number }>('SELECT status, attempts FROM webhook_deliveries');
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await pool.query('UPDATE webhook_deliveries SET next_attempt_at = now()');
    ok = true;
    await d.tick();
    expect((await pool.query('SELECT status FROM webhook_deliveries')).rows[0].status).toBe('delivered');
    const c = calls[1]!;
    expect(verifySignature(m.webhook_secret, c.body, c.headers['x-webhook-timestamp']!, c.headers['x-webhook-signature']!)).toBe(true);
    expect(JSON.parse(c.body).event).toBe('invoice.cancelled');
  });
});

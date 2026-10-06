import { getAddress, zeroPadValue, type Log } from 'ethers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { currentStep, totpAt } from '../src/lib/totp.js';
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
  // Most tests use small amounts: no minimum and no deposit network fee (both tested separately).
  for (const a of registry.assets) {
    await ledger.settings.set(pool, a.id, { ...ledger.settings.defaults(a.id), minAmount: 0n, depositFee: 0n });
  }
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
    expect(payouts[0]!.amount).toBe('106800000'); // minus 1 USDT network fee (TRC20 default)
    expect(payouts[0]!.fee).toBe('1000000');
    expect(payouts[0]!.status).toBe('pending_approval');
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(0n);
    // Not due twice in the same period.
    expect(await ledger.runSettlements(new Date(Date.now() + 2 * 86400_000))).toHaveLength(0);

    expect(await ledger.cancelPayout(payouts[0]!.id, 'rejected', 'test')).toBe(true);
    expect(await ledger.cancelPayout(payouts[0]!.id, 'rejected', 'again')).toBe(false);
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(107_800_000n);
    const summary = await ledger.platformSummary(pool);
    expect(summary[0]!.fees).toBe('2200000');
    expect(summary[0]!.payout_fees).toBe('0'); // refunded with the rejected payout
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

describe('deposit address reuse', () => {
  it('reuses pool addresses only after the cool-down and credits late payments to the last invoice', async () => {
    const m = await merchant();
    const a = await invoices.create(m.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' });
    await invoices.recordDeposit({ invoiceId: a.id, chain: 'tron', asset: 'USDT_TRC20', txHash: 'r1', eventIndex: '0', from: 'X', to: a.address!, amount: 5_000_000n, confirmed: true });
    expect((await invoices.get(pool, a.id))!.status).toBe('paid');

    // Released, but resting: a new invoice gets a different address.
    const b = await invoices.create(m.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' });
    expect(b.address).not.toBe(a.address);

    // A late payment to A's address is still credited to invoice A.
    const watched = await invoices.watched(pool, 'tron');
    expect(watched.find((w) => w.address === a.address)!.id).toBe(a.id);

    // After the cool-down the address comes back for the next invoice.
    await pool.query(`UPDATE deposit_addresses SET released_at = now() - interval '49 hours' WHERE address = $1`, [a.address]);
    const c = await invoices.create(m.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' });
    expect(c.address).toBe(a.address);
    expect(c.derivation_index).toBe(a.derivation_index);
    expect((await invoices.watched(pool, 'tron')).find((w) => w.address === a.address)!.id).toBe(c.id);

    // Pools are per merchant: another merchant never receives this address.
    const other = await merchant();
    await pool.query(`UPDATE deposit_addresses SET released_at = now() - interval '49 hours'`);
    const d = await invoices.create(other.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' });
    expect([a.address, b.address]).not.toContain(d.address);
  });

  it('enforces the pool limit', async () => {
    const m = await merchant();
    const { InvoiceService } = await import('../src/services/invoices.js');
    const { rates } = await import('../src/services/index.js');
    const small = new InvoiceService({ registry, rates, ledger, wallet: (await import('../src/context.js')).walletFor, poolMax: 1 });
    await small.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_TRC20' });
    await expect(small.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_TRC20' })).rejects.toThrow(/No free deposit address/);
  });

  it('gives each customer a permanent address and one open invoice at a time', async () => {
    const m = await merchant();
    const a = await invoices.create(m.id, { price_amount: '4', price_currency: 'USD', asset: 'USDT_TRC20', customer_id: 'user-42' });
    const b = await invoices.create(m.id, { price_amount: '6', price_currency: 'USD', asset: 'USDT_TRC20', customer_id: 'user-42' });
    expect(b.address).toBe(a.address);
    expect((await invoices.get(pool, a.id))!.status).toBe('cancelled'); // unpaid predecessor dropped
    const other = await invoices.create(m.id, { price_amount: '6', price_currency: 'USD', asset: 'USDT_TRC20', customer_id: 'user-43' });
    expect(other.address).not.toBe(a.address);

    // Payment in flight on b blocks a third invoice for the same customer.
    await invoices.recordDeposit({ invoiceId: b.id, chain: 'tron', asset: 'USDT_TRC20', txHash: 'c1', eventIndex: '0', from: 'X', to: b.address!, amount: 6_000_000n });
    await expect(invoices.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_TRC20', customer_id: 'user-42' })).rejects.toThrow(/payment in progress/);

    // Once paid, a repeat payment without a new invoice is credited to b and reported.
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM deposits WHERE tx_hash = 'c1'`);
    await invoices.updateDepositConfirmations(rows[0]!.id, 19, 'confirmed');
    expect((await invoices.get(pool, b.id))!.status).toBe('paid');
    await pool.query(`UPDATE deposit_addresses SET released_at = now() - interval '10 days' WHERE customer_id = 'user-42'`);
    const w = (await invoices.watched(pool, 'tron')).find((x) => x.address === b.address);
    expect(w!.id).toBe(b.id); // still watched (30-day customer window)
    await invoices.recordDeposit({ invoiceId: b.id, chain: 'tron', asset: 'USDT_TRC20', txHash: 'c2', eventIndex: '0', from: 'X', to: b.address!, amount: 3_000_000n, confirmed: true });
    expect((await invoices.get(pool, b.id))!.amount_received).toBe('9000000');
    expect(await events(b.id)).toContain('invoice.updated');

    // A new invoice for the customer reuses the same permanent address.
    const c = await invoices.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_TRC20', customer_id: 'user-42' });
    expect(c.address).toBe(a.address);
    expect(c.customer_id).toBe('user-42');
  });
});

describe('sweep threshold and liquidity', () => {
  it('sweeps only above the threshold unless approved payouts need the funds', async () => {
    const { SweepJob } = await import('../src/sweeper/signer.js');
    const m = await merchant();
    const swept: string[] = [];
    let hot = 0n;
    const signer = {
      chain: 'tron',
      hotAddress: 'THot',
      validateAddress: () => true,
      txState: async () => 'pending' as const,
      preparePayout: async () => { throw new Error('unused'); },
      hotBalance: async () => hot,
      sweep: async (_i: number, addr: string) => {
        swept.push(addr);
        return 'swept' as const;
      },
    };
    const job = new SweepJob([signer], registry, ledger.settings, silent);
    const mk = async (cust: string, amount: bigint, tx: string) => {
      const inv = await invoices.create(m.id, { price_amount: '1', price_currency: 'USD', asset: 'USDT_TRC20', customer_id: cust });
      await invoices.recordDeposit({ invoiceId: inv.id, chain: 'tron', asset: 'USDT_TRC20', txHash: tx, eventIndex: '0', from: 'X', to: inv.address!, amount, confirmed: true });
      return inv.address!;
    };
    const small = await mk('u1', 40_000_000n, 's1'); // 40 USDT < 100 threshold
    const big = await mk('u2', 150_000_000n, 's2'); // 150 USDT
    await job.tick();
    expect(swept).toEqual([big]);

    // An approved 180 USDT payout with an empty hot wallet needs more than the big address holds,
    // so the small address is swept early as well.
    await pool.query(
      `INSERT INTO payouts (merchant_id, asset, chain, address, amount, fee, status) VALUES ($1, 'USDT_TRC20', 'tron', 'TDest', 180000000, 1000000, 'approved')`,
      [m.id],
    );
    hot = 0n;
    swept.length = 0;
    await pool.query(`DELETE FROM sweeps`);
    await job.tick();
    expect(swept).toContain(small);

    // Raising the threshold via settings keeps it waiting again.
    await pool.query(`DELETE FROM payouts`);
    await ledger.settings.set(pool, 'USDT_TRC20', { ...ledger.settings.defaults('USDT_TRC20'), sweepThreshold: 500_000_000n });
    swept.length = 0;
    await pool.query(`DELETE FROM sweeps`);
    await job.tick();
    expect(swept).toEqual([]);
  });
});

describe('concurrency', () => {
  it('100 customers paying the same amount at the same time are each credited exactly once', async () => {
    const m = await merchant(1);
    const N = 100;
    // 100 invoices created concurrently (half with customer ids, half from the pool), all for 4 USDT.
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        invoices.create(m.id, { price_amount: '4', price_currency: 'USD', asset: 'USDT_TRC20', ...(i % 2 ? { customer_id: `user-${i}` } : {}) }),
      ),
    );
    expect(new Set(created.map((c) => c.address)).size).toBe(N); // every invoice got its own address
    expect(new Set(created.map((c) => c.derivation_index)).size).toBe(N);

    // Identical 4 USDT deposits all arrive at once; each one is also delivered twice (watcher retries).
    const deposit = (inv: (typeof created)[number], i: number) =>
      invoices.recordDeposit({ invoiceId: inv.id, chain: 'tron', asset: 'USDT_TRC20', txHash: `tx-${i}`, eventIndex: '0', from: `TPayer${i}`, to: inv.address!, amount: 4_000_000n, confirmed: true });
    await Promise.all([...created.map(deposit), ...created.map(deposit)]);

    const { rows } = await pool.query<{ status: string; amount_received: string; n: string }>(
      `SELECT i.status, i.amount_received, (SELECT COUNT(*) FROM deposits d WHERE d.invoice_id = i.id) AS n
       FROM invoices i WHERE merchant_id = $1`,
      [m.id],
    );
    expect(rows).toHaveLength(N);
    for (const r of rows) {
      expect(r.status).toBe('paid');
      expect(r.amount_received).toBe('4000000');
      expect(r.n).toBe('1');
    }
    // Ledger: 100 × 4 USDT minus 1% = 396 USDT, credited exactly once.
    expect((await ledger.balances(pool, m.id))[0]!.balance).toBe(396_000_000n);
    const { rows: wh } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE merchant_id = $1 AND event = 'invoice.paid'`, [m.id]);
    expect(wh[0]!.n).toBe(String(N));
  }, 60000);
});

describe('minimum amounts and deposit network fee', () => {
  it('hides and rejects networks below their minimum', async () => {
    const m = await merchant(1);
    await ledger.settings.set(pool, 'USDT_TRC20', { ...ledger.settings.defaults('USDT_TRC20'), minAmount: 10_000_000n, depositFee: 0n });
    await expect(invoices.create(m.id, { price_amount: '4', price_currency: 'USD', asset: 'USDT_TRC20' })).rejects.toThrow(/minimum/);
    const open = await invoices.create(m.id, { price_amount: '4', price_currency: 'USD' });
    const ids = (await invoices.payableAssets(open)).map((a) => a.id);
    expect(ids).not.toContain('USDT_TRC20');
    expect(ids).toContain('USDT_BEP20');
    await expect(invoices.selectAsset(open.id, 'USDT_TRC20')).rejects.toThrow(/minimum/);
    // 20 USD is fine on TRC20.
    expect((await invoices.create(m.id, { price_amount: '20', price_currency: 'USD', asset: 'USDT_TRC20' })).pay_amount).toBe('20000000');
  });

  it('charges the network fee to the customer or the merchant', async () => {
    await ledger.settings.set(pool, 'USDT_TRC20', { ...ledger.settings.defaults('USDT_TRC20'), minAmount: 0n, depositFee: 1_000_000n });
    const pay = async (inv: { id: string; address: string | null; pay_amount: string | null }, tx: string) =>
      invoices.recordDeposit({ invoiceId: inv.id, chain: 'tron', asset: 'USDT_TRC20', txHash: tx, eventIndex: '0', from: 'X', to: inv.address!, amount: BigInt(inv.pay_amount!), confirmed: true });

    // Customer pays: 5 USD + 1 USDT fee due; merchant nets 5 minus 1%.
    const mc = await merchant(1);
    await pool.query(`UPDATE merchants SET fee_payer = 'customer' WHERE id = $1`, [mc.id]);
    const a = await invoices.create(mc.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' });
    expect(a.pay_amount).toBe('6000000');
    await pay(a, 'f1');
    expect((await invoices.get(pool, a.id))!.status).toBe('paid');
    expect((await ledger.balances(pool, mc.id))[0]!.balance).toBe(4_950_000n);

    // Merchant pays (default): customer sends 5; merchant nets 5 - 1 - 1% of 4.
    const mm = await merchant(1);
    const b = await invoices.create(mm.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' });
    expect(b.pay_amount).toBe('5000000');
    await pay(b, 'f2');
    expect((await ledger.balances(pool, mm.id))[0]!.balance).toBe(3_960_000n);

    // Per-invoice override beats the merchant setting.
    const c = await invoices.create(mm.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20', fee_paid_by: 'customer' });
    expect(c.pay_amount).toBe('6000000');

    const summary = (await ledger.platformSummary(pool)).find((r) => r.asset === 'USDT_TRC20')!;
    expect(summary.network_fees).toBe('2000000');
  });
});

describe('cold storage', () => {
  it('moves only the surplus above hot_max plus pending payouts, one transfer at a time', async () => {
    const { ColdStorageJob } = await import('../src/sweeper/signer.js');
    const m = await merchant();
    await ledger.settings.set(pool, 'USDT_TRC20', { ...ledger.settings.defaults('USDT_TRC20'), hotMax: 1000_000000n });
    let hot = 1050_000000n;
    let state: 'pending' | 'success' = 'pending';
    const sent: { to: string; amount: bigint }[] = [];
    const signer = {
      chain: 'tron',
      hotAddress: 'THot',
      validateAddress: () => true,
      txState: async () => state,
      hotBalance: async (a: { contract?: string }) => (a.contract ? hot : 0n),
      sweep: async () => 'empty' as const,
      preparePayout: async (_a: unknown, to: string, amount: bigint) => {
        sent.push({ to, amount });
        return { hash: `cold-${sent.length}`, broadcast: async () => undefined };
      },
    };
    const job = new ColdStorageJob([signer], () => 'TCold', registry, ledger.settings, silent);

    await job.tick();
    expect(sent).toEqual([]); // 50 surplus < 10% of the 1000 cap: not worth a transfer

    hot = 1500_000000n;
    await pool.query(
      `INSERT INTO payouts (merchant_id, asset, chain, address, amount, fee, status) VALUES ($1, 'USDT_TRC20', 'tron', 'TDest', 199000000, 1000000, 'approved')`,
      [m.id],
    );
    await job.tick();
    expect(sent).toEqual([{ to: 'TCold', amount: 300_000000n }]); // 1500 - (1000 cap + 200 reserved for the payout)

    await job.tick(); // previous transfer still pending: nothing new
    expect(sent).toHaveLength(1);
    state = 'success';
    hot = 1200_000000n;
    await job.tick();
    expect(sent).toHaveLength(1); // nothing left above the cap
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM sweeps WHERE kind = 'to_cold'`);
    expect(rows.map((r) => r.status)).toEqual(['confirmed']);
  });
});

describe('security controls', () => {
  it('2FA protects login and sensitive actions, and codes cannot be replayed', async () => {
    const app = await buildServer();
    const m = await merchant();
    const login = (extra: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.email, password: 'password1234', ...extra } });
    const cookie = String((await login()).headers['set-cookie']).split(';')[0]!;

    const setup = (await app.inject({ method: 'POST', url: '/api/panel/2fa/setup', headers: { cookie }, payload: {} })).json();
    expect(setup.otpauth_uri).toContain('otpauth://totp/');
    const step = currentStep();
    const code = totpAt(setup.secret, step);
    expect((await app.inject({ method: 'POST', url: '/api/panel/2fa/enable', headers: { cookie }, payload: { code: '000000' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/panel/2fa/enable', headers: { cookie }, payload: { code } })).statusCode).toBe(200);

    // Login now needs a code; the one used to enable cannot be reused.
    expect((await login()).json().error.code).toBe('otp_required');
    expect((await login({ otp: code })).json().error.code).toBe('otp_invalid');
    const next = totpAt(setup.secret, step + 1);
    expect((await login({ otp: next })).statusCode).toBe(200);

    // Sensitive action without / with a code.
    const keyReq = (otp?: string) =>
      app.inject({ method: 'POST', url: '/api/panel/api-keys', headers: { cookie, ...(otp ? { 'x-otp': otp } : {}) }, payload: { label: 'shop', allowed_ips: '203.0.113.7, 10.0.0.0/24' } });
    expect((await keyReq()).json().error.code).toBe('otp_required');
    // step+1 was consumed by the login; a later step is accepted only within the ±1 window, so roll the clock forward.
    const { rows } = await pool.query<{ totp_last_step: string }>('SELECT totp_last_step FROM merchants WHERE id = $1', [m.id]);
    await pool.query('UPDATE merchants SET totp_last_step = $2 WHERE id = $1', [m.id, Number(rows[0]!.totp_last_step) - 2]);
    const created = await keyReq(totpAt(setup.secret, step));
    expect(created.statusCode).toBe(200);
    expect(created.json().allowed_ips).toEqual(['203.0.113.7', '10.0.0.0/24']);

    // IP allowlist on the API key.
    const key = created.json().key as string;
    const call = (ip: string) =>
      app.inject({ method: 'GET', url: '/v1/balances', headers: { authorization: `Bearer ${key}` }, remoteAddress: ip });
    expect((await call('198.51.100.1')).statusCode).toBe(403);
    expect((await call('203.0.113.7')).statusCode).toBe(200);
    expect((await call('10.0.0.42')).statusCode).toBe(200);

    const { rows: log } = await pool.query<{ action: string }>('SELECT action FROM audit_log WHERE merchant_id = $1 ORDER BY id', [m.id]);
    expect(log.map((r) => r.action)).toEqual(expect.arrayContaining(['login', '2fa.enabled', 'api_key.created']));
    await app.close();
  });

  it('holds payouts to a changed payout address', async () => {
    const app = await buildServer();
    const m = await merchant();
    const cookie = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.email, password: 'password1234' } })).headers['set-cookie']).split(';')[0]!;
    const setAddr = (address: string) =>
      app.inject({ method: 'PUT', url: '/api/panel/payout-addresses', headers: { cookie }, payload: { asset: 'USDT_TRC20', address } });
    await ledger.adjust(m.id, 'USDT_TRC20', 50_000_000n, 'test credit');

    expect((await setAddr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).json().held_hours).toBe(0); // first address: no hold
    expect((await setAddr('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')).json().held_hours).toBe(24); // change: held
    const req = await app.inject({ method: 'POST', url: '/api/panel/payouts', headers: { cookie }, payload: { asset: 'USDT_TRC20' } });
    expect(req.json().error.code).toBe('address_on_hold');
    expect(await withTx((db) => ledger.createPayout(db, m.id, 'USDT_TRC20', { respectMinimum: false }))).toBeNull();

    await pool.query(`UPDATE payout_addresses SET locked_until = now() - interval '1 minute' WHERE merchant_id = $1`, [m.id]);
    expect((await app.inject({ method: 'POST', url: '/api/panel/payouts', headers: { cookie }, payload: { asset: 'USDT_TRC20' } })).statusCode).toBe(200);
    await app.close();
  });

  it('requires an admin 2FA code for every admin change once enabled', async () => {
    const app = await buildServer();
    const m = await merchant();
    await createAdmin(pool, 'ops@x.io', 'adminpassword1');
    const cookie = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ops@x.io', password: 'adminpassword1', role: 'admin' } })).headers['set-cookie']).split(';')[0]!;
    const setup = (await app.inject({ method: 'POST', url: '/api/admin/2fa/setup', headers: { cookie }, payload: {} })).json();
    const step = currentStep();
    await app.inject({ method: 'POST', url: '/api/admin/2fa/enable', headers: { cookie }, payload: { code: totpAt(setup.secret, step - 1) } });

    const patch = (otp?: string) =>
      app.inject({ method: 'PATCH', url: `/api/admin/merchants/${m.id}`, headers: { cookie, ...(otp ? { 'x-otp': otp } : {}) }, payload: { fee_percent: 2 } });
    expect((await patch()).json().error.code).toBe('otp_required');
    expect((await patch(totpAt(setup.secret, step))).statusCode).toBe(200);
    const { rows } = await pool.query<{ action: string }>(`SELECT action FROM audit_log WHERE actor_type = 'admin' ORDER BY id`);
    expect(rows.map((r) => r.action)).toContain('admin PATCH /api/admin/merchants/:id');
    await app.close();
  });
});

describe('per-merchant currencies and stats', () => {
  it('restricts a merchant to the currencies the admin allowed', async () => {
    const m = await merchant();
    await pool.query(`UPDATE merchants SET allowed_assets = ARRAY['USDT_BEP20','USDT_TON'] WHERE id = $1`, [m.id]);
    expect((await invoices.merchantAssets(m.id)).map((a) => a.id)).toEqual(['USDT_BEP20', 'USDT_TON']);
    await expect(invoices.create(m.id, { price_amount: '5', price_currency: 'USD', asset: 'USDT_TRC20' })).rejects.toThrow(/not enabled/);
    const open = await invoices.create(m.id, { price_amount: '5', price_currency: 'USD' });
    expect((await invoices.payableAssets(open)).map((a) => a.id)).toEqual(['USDT_BEP20', 'USDT_TON']);
    await expect(invoices.selectAsset(open.id, 'USDT_TRC20')).rejects.toThrow(/not enabled/);
    expect((await invoices.selectAsset(open.id, 'USDT_BEP20')).asset).toBe('USDT_BEP20');
    // Other merchants are unaffected.
    expect((await invoices.merchantAssets((await merchant()).id)).length).toBeGreaterThan(2);
  });

  it('reports zero-filled daily stats', async () => {
    const { dailyStats } = await import('../src/api/panel.js');
    const m = await merchant();
    const inv = await invoices.create(m.id, { price_amount: '12.5', price_currency: 'USD', asset: 'USDT_TRC20' });
    await invoices.recordDeposit({ invoiceId: inv.id, chain: 'tron', asset: 'USDT_TRC20', txHash: 'st1', eventIndex: '0', from: 'X', to: inv.address!, amount: 12_500_000n, confirmed: true });
    const s = await dailyStats(m.id, 7);
    expect(s).toHaveLength(7);
    expect(s[6]).toMatchObject({ paid: 1, volume: 12.5 });
    expect(s.slice(0, 6).every((d) => d.paid === 0)).toBe(true);
  });
});

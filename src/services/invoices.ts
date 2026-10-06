import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.js';
import { pool, withTx, type Queryable } from '../db.js';
import { enabledAssets, findAsset, type AssetDef, type Registry } from '../chains/assets.js';
import { fromBaseUnits, quoteAmount, trimDecimal } from '../lib/amount.js';
import type { KeyFamily, WatchOnlyWallet } from '../wallet/hd.js';
import type { LedgerService } from './ledger.js';
import type { RateService } from './rates.js';
import { computeStatus, type InvoiceStatus } from './status.js';
import { enqueueWebhook } from './webhooks.js';

export interface InvoiceRow {
  id: string;
  merchant_id: string;
  order_id: string | null;
  description: string | null;
  price_amount: string;
  price_currency: string;
  asset: string | null;
  chain: string | null;
  address: string | null;
  memo: string | null;
  derivation_index: string | null;
  pay_amount: string | null;
  rate: string | null;
  amount_received: string;
  amount_pending: string;
  status: InvoiceStatus;
  customer_id: string | null;
  deposit_address_id: string | null;
  fee_percent: string | null;
  fee_amount: string;
  is_late: boolean;
  success_url: string | null;
  cancel_url: string | null;
  metadata: Record<string, unknown>;
  expires_at: Date;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DepositRow {
  id: string;
  invoice_id: string | null;
  chain: string;
  asset: string;
  tx_hash: string;
  event_index: string;
  from_address: string | null;
  to_address: string;
  memo: string | null;
  amount: string;
  block_number: string | null;
  block_hash: string | null;
  confirmations: number;
  status: 'pending' | 'confirmed' | 'orphaned';
  detected_at: Date;
  confirmed_at: Date | null;
}

export interface NewDeposit {
  invoiceId: string | null;
  chain: string;
  asset: string;
  txHash: string;
  eventIndex: string;
  from: string | null;
  to: string;
  memo?: string | null;
  amount: bigint;
  blockNumber?: bigint | number | null;
  blockHash?: string | null;
  confirmations?: number;
  confirmed?: boolean;
}

export interface CreateInvoiceInput {
  price_amount: string;
  price_currency: string;
  asset?: string;
  order_id?: string;
  description?: string;
  success_url?: string;
  cancel_url?: string;
  metadata?: Record<string, unknown>;
  expires_in_minutes?: number;
  /** Merchant's own user id: that user always gets the same deposit address. */
  customer_id?: string;
}

export class InvoiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'invalid_request',
  ) {
    super(message);
  }
}

export interface InvoiceServiceDeps {
  registry: Registry;
  rates: RateService;
  ledger: LedgerService;
  wallet: (family: KeyFamily) => WatchOnlyWallet;
  tonTreasury?: string;
  tolerancePercent?: number;
  defaultTtlMinutes?: number;
  lateWindowHours?: number;
  publicBaseUrl?: string;
  poolCooldownHours?: number;
  poolMax?: number;
  customerWatchDays?: number;
}

const MEMO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateMemo(length = 10): string {
  let s = '';
  for (let i = 0; i < length; i++) s += MEMO_ALPHABET[randomInt(MEMO_ALPHABET.length)];
  return s;
}

export class InvoiceService {
  readonly tolerancePercent: number;
  readonly defaultTtlMinutes: number;
  readonly lateWindowHours: number;
  readonly publicBaseUrl: string;
  readonly poolCooldownHours: number;
  readonly poolMax: number;
  readonly customerWatchDays: number;

  constructor(private readonly deps: InvoiceServiceDeps) {
    this.tolerancePercent = deps.tolerancePercent ?? config.UNDERPAY_TOLERANCE_PERCENT;
    this.defaultTtlMinutes = deps.defaultTtlMinutes ?? config.INVOICE_TTL_MINUTES;
    this.lateWindowHours = deps.lateWindowHours ?? config.LATE_PAYMENT_WINDOW_HOURS;
    this.publicBaseUrl = (deps.publicBaseUrl ?? config.PUBLIC_BASE_URL).replace(/\/$/, '');
    this.poolCooldownHours = deps.poolCooldownHours ?? config.ADDRESS_POOL_COOLDOWN_HOURS;
    this.poolMax = deps.poolMax ?? config.ADDRESS_POOL_MAX;
    this.customerWatchDays = deps.customerWatchDays ?? config.CUSTOMER_ADDRESS_WATCH_DAYS;
  }

  get registry(): Registry {
    return this.deps.registry;
  }

  asset(id: string): AssetDef {
    const a = findAsset(this.deps.registry, id);
    if (!a || !this.deps.registry.chains[a.chain].enabled) {
      throw new InvoiceError(`Asset ${id} is not supported or not enabled`, 400, 'unsupported_asset');
    }
    return a;
  }

  // ------------------------------------------------------------------ create / select

  async create(merchantId: string, input: CreateInvoiceInput): Promise<InvoiceRow> {
    const price = input.price_amount.trim();
    if (!/^\d+(\.\d{1,8})?$/.test(price) || Number(price) <= 0) {
      throw new InvoiceError('price_amount must be a positive decimal string with at most 8 decimals');
    }
    const currency = input.price_currency.trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,12}$/.test(currency)) throw new InvoiceError('Invalid price_currency');
    const asset = input.asset ? this.asset(input.asset) : undefined;
    const customerId = input.customer_id?.trim() || null;
    if (customerId && !/^[\w.@:+-]{1,128}$/.test(customerId)) {
      throw new InvoiceError('customer_id must be 1-128 characters: letters, digits, . _ - @ : +');
    }

    // Quote before opening the DB transaction so a slow price API never holds locks.
    const quote = asset ? await this.quote(asset, price, currency) : undefined;
    const ttl = input.expires_in_minutes ?? this.defaultTtlMinutes;
    if (ttl < 5 || ttl > 7 * 24 * 60) throw new InvoiceError('expires_in_minutes must be between 5 and 10080');

    return withTx(async (db) => {
      if (input.order_id) {
        const existing = await db.query<InvoiceRow>(
          'SELECT * FROM invoices WHERE merchant_id = $1 AND order_id = $2',
          [merchantId, input.order_id],
        );
        if (existing.rows[0]) {
          throw new InvoiceError(`An invoice for order_id ${input.order_id} already exists`, 409, 'duplicate_order');
        }
      }
      const { rows } = await db.query<InvoiceRow>(
        `INSERT INTO invoices (merchant_id, order_id, description, price_amount, price_currency,
                               success_url, cancel_url, metadata, expires_at, customer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9), $10)
         RETURNING *`,
        [
          merchantId,
          input.order_id ?? null,
          input.description ?? null,
          price,
          currency,
          input.success_url ?? null,
          input.cancel_url ?? null,
          JSON.stringify(input.metadata ?? {}),
          ttl,
          customerId,
        ],
      );
      let invoice = rows[0]!;
      if (asset && quote) invoice = await this.assign(db, invoice, asset, quote);
      return invoice;
    });
  }

  /** Payer picked a currency on the hosted page (or the merchant passed `asset` later). */
  async selectAsset(invoiceId: string, assetId: string): Promise<InvoiceRow> {
    const asset = this.asset(assetId);
    const current = await this.get(pool, invoiceId);
    if (!current) throw new InvoiceError('Invoice not found', 404, 'not_found');
    if (current.asset) {
      if (current.asset === asset.id) return current;
      throw new InvoiceError('A currency was already selected for this invoice', 409, 'asset_locked');
    }
    if (current.status !== 'pending' || current.expires_at < new Date()) {
      throw new InvoiceError('Invoice is no longer payable', 409, 'not_payable');
    }
    const quote = await this.quote(asset, current.price_amount, current.price_currency);
    return withTx(async (db) => {
      const { rows } = await db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      const inv = rows[0]!;
      if (inv.asset) {
        if (inv.asset === asset.id) return inv;
        throw new InvoiceError('A currency was already selected for this invoice', 409, 'asset_locked');
      }
      return this.assign(db, inv, asset, quote);
    });
  }

  private async quote(asset: AssetDef, price: string, currency: string): Promise<{ rate: string; amount: bigint }> {
    let rate: string;
    try {
      rate = await this.deps.rates.rate(asset, currency);
    } catch (err) {
      throw new InvoiceError(`Could not get ${asset.symbol}/${currency} rate: ${(err as Error).message}`, 503, 'rate_unavailable');
    }
    const amount = quoteAmount(price, rate, asset.decimals, asset.displayDecimals);
    if (amount <= 0n) throw new InvoiceError('Quoted amount is zero');
    return { rate, amount };
  }

  private async assign(
    db: pg.PoolClient,
    invoice: InvoiceRow,
    asset: AssetDef,
    quote: { rate: string; amount: bigint },
  ): Promise<InvoiceRow> {
    const chain = this.deps.registry.chains[asset.chain];
    let address: string;
    let memo: string | null = null;
    let index: string | null = null;
    let addressId: string | null = null;

    if (chain.usesMemo) {
      if (!this.deps.tonTreasury) throw new InvoiceError('TON treasury address not configured', 500, 'misconfigured');
      address = this.deps.tonTreasury;
      memo = generateMemo();
    } else {
      const a = await this.allocateAddress(db, chain.family as KeyFamily, invoice);
      address = a.address;
      index = a.derivation_index;
      addressId = a.id;
    }

    const { rows } = await db.query<InvoiceRow>(
      `UPDATE invoices SET asset = $2, chain = $3, address = $4, memo = $5, derivation_index = $6,
              pay_amount = $7, rate = $8, deposit_address_id = $9, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [invoice.id, asset.id, asset.chain, address, memo, index, quote.amount.toString(), quote.rate, addressId],
    );
    return rows[0]!;
  }

  /**
   * Picks the deposit address for an invoice and binds it as the address's current invoice.
   * - customer_id given: that customer's permanent address (created on first use). A still-unpaid
   *   earlier invoice of the same customer is cancelled; one with payments in flight blocks.
   * - otherwise: a free address from the merchant's pool that has rested for the cool-down period,
   *   so a late payment to an old invoice is not credited to a new one; a new address is derived
   *   only when none is free (up to the pool limit).
   */
  private async allocateAddress(
    db: pg.PoolClient,
    family: KeyFamily,
    invoice: InvoiceRow,
  ): Promise<{ id: string; address: string; derivation_index: string }> {
    type Row = { id: string; address: string; derivation_index: string; current_invoice_id: string | null };
    let row: Row | undefined;

    if (invoice.customer_id) {
      ({ rows: [row] } = await db.query<Row>(
        `SELECT id, address, derivation_index, current_invoice_id FROM deposit_addresses
         WHERE merchant_id = $1 AND family = $2 AND customer_id = $3 FOR UPDATE`,
        [invoice.merchant_id, family, invoice.customer_id],
      ));
      if (row?.current_invoice_id && row.current_invoice_id !== invoice.id) {
        await this.releaseBusyCustomerInvoice(db, row.current_invoice_id);
      }
    } else {
      ({ rows: [row] } = await db.query<Row>(
        `SELECT id, address, derivation_index, current_invoice_id FROM deposit_addresses
         WHERE merchant_id = $1 AND family = $2 AND customer_id IS NULL AND current_invoice_id IS NULL
           AND (released_at IS NULL OR released_at < now() - make_interval(hours => $3))
         ORDER BY released_at NULLS FIRST, id
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [invoice.merchant_id, family, this.poolCooldownHours],
      ));
      if (!row) {
        const { rows: c } = await db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM deposit_addresses WHERE merchant_id = $1 AND family = $2 AND customer_id IS NULL`,
          [invoice.merchant_id, family],
        );
        if (Number(c[0]!.n) >= this.poolMax) {
          throw new InvoiceError('No free deposit address right now, try again later', 503, 'address_pool_exhausted');
        }
      }
    }

    if (!row) {
      const { rows } = await db.query<{ idx: string }>(
        `INSERT INTO hd_counters (family, next_index) VALUES ($1, 1)
         ON CONFLICT (family) DO UPDATE SET next_index = hd_counters.next_index + 1
         RETURNING next_index - 1 AS idx`,
        [family],
      );
      const index = BigInt(rows[0]!.idx);
      if (index >= 2n ** 31n) throw new Error('HD index space exhausted');
      const address = this.deps.wallet(family).deriveAddress(Number(index));
      ({ rows: [row] } = await db.query<Row>(
        `INSERT INTO deposit_addresses (family, derivation_index, address, merchant_id, customer_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, address, derivation_index, current_invoice_id`,
        [family, index.toString(), address, invoice.merchant_id, invoice.customer_id],
      ));
    }

    await db.query(
      `UPDATE deposit_addresses SET current_invoice_id = $2, last_invoice_id = $2, released_at = NULL WHERE id = $1`,
      [row!.id, invoice.id],
    );
    return row!;
  }

  /** A customer opened a new invoice: drop the previous one if nothing was paid on it yet. */
  private async releaseBusyCustomerInvoice(db: pg.PoolClient, invoiceId: string): Promise<void> {
    const { rows } = await db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    const prev = rows[0];
    if (!prev || !['pending', 'expired'].includes(prev.status)) {
      if (prev && ['confirming', 'partially_paid'].includes(prev.status)) {
        throw new InvoiceError(
          'This customer has a payment in progress on another invoice; wait until it completes',
          409,
          'customer_busy',
        );
      }
      return;
    }
    const { rows: d } = await db.query('SELECT 1 FROM deposits WHERE invoice_id = $1 AND status <> $2 LIMIT 1', [invoiceId, 'orphaned']);
    if (d.length) throw new InvoiceError('This customer has a payment in progress on another invoice', 409, 'customer_busy');
    if (prev.status === 'pending') {
      const { rows: up } = await db.query<InvoiceRow>(
        `UPDATE invoices SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
        [invoiceId],
      );
      await enqueueWebhook(db, prev.merchant_id, invoiceId, 'invoice.cancelled', this.serialize(up[0]!, []));
    }
  }

  /** Frees the invoice's address once the invoice no longer expects payments. */
  private async releaseAddress(db: pg.PoolClient, inv: InvoiceRow): Promise<void> {
    if (!inv.deposit_address_id) return;
    const done =
      ['paid', 'expired', 'cancelled'].includes(inv.status) || (inv.status === 'partially_paid' && inv.expires_at < new Date());
    if (!done) return;
    await db.query(
      `UPDATE deposit_addresses SET current_invoice_id = NULL, released_at = now() WHERE id = $1 AND current_invoice_id = $2`,
      [inv.deposit_address_id, inv.id],
    );
  }

  // ------------------------------------------------------------------ reads

  async get(db: Queryable, id: string, merchantId?: string): Promise<InvoiceRow | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { rows } = await db.query<InvoiceRow>(
      merchantId ? 'SELECT * FROM invoices WHERE id = $1 AND merchant_id = $2' : 'SELECT * FROM invoices WHERE id = $1',
      merchantId ? [id, merchantId] : [id],
    );
    return rows[0];
  }

  async deposits(db: Queryable, invoiceId: string): Promise<DepositRow[]> {
    const { rows } = await db.query<DepositRow>(
      'SELECT * FROM deposits WHERE invoice_id = $1 ORDER BY detected_at',
      [invoiceId],
    );
    return rows;
  }

  /**
   * Addresses to monitor on `chain`, each with the invoice a payment to it is credited to:
   * the address's open invoice, or else its most recent one (late payments) while within the
   * late-payment window — or, for a customer's permanent address, the longer customer window
   * (customers may pay again without opening an invoice). One row per address.
   */
  async watched(db: Queryable, chain: string): Promise<InvoiceRow[]> {
    const { rows } = await db.query<InvoiceRow>(
      `SELECT i.* FROM deposit_addresses da
       JOIN invoices i ON i.id = COALESCE(da.current_invoice_id, da.last_invoice_id)
       WHERE i.chain = $1
         AND (da.current_invoice_id IS NOT NULL
              OR da.released_at > now() - make_interval(hours => $2)
              OR (da.customer_id IS NOT NULL AND da.released_at > now() - make_interval(days => $3))
              OR i.status IN ('pending', 'confirming'))`,
      [chain, this.lateWindowHours, this.customerWatchDays],
    );
    return rows;
  }

  // ------------------------------------------------------------------ deposits & state

  /** Idempotently stores a deposit and re-evaluates its invoice. Returns true if it was new. */
  async recordDeposit(d: NewDeposit): Promise<boolean> {
    return withTx(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO deposits (invoice_id, chain, asset, tx_hash, event_index, from_address, to_address, memo,
                               amount, block_number, block_hash, confirmations, status, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13 = 'confirmed' THEN now() END)
         ON CONFLICT (chain, tx_hash, event_index) DO NOTHING
         RETURNING id`,
        [
          d.invoiceId,
          d.chain,
          d.asset,
          d.txHash,
          d.eventIndex,
          d.from,
          d.to,
          d.memo ?? null,
          d.amount.toString(),
          d.blockNumber?.toString() ?? null,
          d.blockHash ?? null,
          d.confirmations ?? 0,
          d.confirmed ? 'confirmed' : 'pending',
        ],
      );
      if (!rows[0]) return false;
      if (d.invoiceId) await this.recompute(db, d.invoiceId);
      return true;
    });
  }

  async updateDepositConfirmations(
    depositId: string,
    confirmations: number,
    state: 'pending' | 'confirmed' | 'orphaned',
  ): Promise<void> {
    await withTx(async (db) => {
      const { rows } = await db.query<{ invoice_id: string | null; status: string }>(
        `UPDATE deposits SET confirmations = $2, status = $3,
                confirmed_at = CASE WHEN $3 = 'confirmed' THEN now() ELSE confirmed_at END
         WHERE id = $1 AND status = 'pending'
         RETURNING invoice_id, status`,
        [depositId, confirmations, state],
      );
      const invoiceId = rows[0]?.invoice_id;
      if (invoiceId && state !== 'pending') await this.recompute(db, invoiceId);
    });
  }

  /** Recalculates totals and status under a row lock; emits a webhook on every status change. */
  async recompute(db: pg.PoolClient, invoiceId: string): Promise<InvoiceRow> {
    const { rows } = await db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    const inv = rows[0];
    if (!inv) throw new Error(`Invoice ${invoiceId} not found`);

    const sums = await db.query<{ status: string; total: string; last_seen: Date }>(
      `SELECT status, COALESCE(SUM(amount), 0) AS total, MAX(detected_at) AS last_seen
       FROM deposits WHERE invoice_id = $1 AND status <> 'orphaned' GROUP BY status`,
      [invoiceId],
    );
    const confirmed = BigInt(sums.rows.find((r) => r.status === 'confirmed')?.total ?? '0');
    const pending = BigInt(sums.rows.find((r) => r.status === 'pending')?.total ?? '0');
    const lastSeen = sums.rows.reduce<Date | null>((m, r) => (!m || r.last_seen > m ? r.last_seen : m), null);

    const next = computeStatus({
      current: inv.status,
      payAmount: inv.pay_amount ? BigInt(inv.pay_amount) : null,
      confirmed,
      pending,
      expiresAt: inv.expires_at,
      now: new Date(),
      tolerancePercent: this.tolerancePercent,
    });

    const becamePaid = next === 'paid' && inv.status !== 'paid';
    const { rows: updated } = await db.query<InvoiceRow>(
      `UPDATE invoices SET amount_received = $2, amount_pending = $3, status = $4,
              paid_at = CASE WHEN $5 THEN now() ELSE paid_at END,
              is_late = CASE WHEN $5 THEN $6 ELSE is_late END,
              updated_at = now()
       WHERE id = $1 RETURNING *`,
      [invoiceId, confirmed.toString(), pending.toString(), next, becamePaid, !!lastSeen && lastSeen > inv.expires_at],
    );
    let after = updated[0]!;
    await this.releaseAddress(db, after);
    if (after.status === 'paid') {
      const credited = await this.deps.ledger.creditInvoice(db, after);
      if (credited > 0n) after = (await db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0]!;
    }
    if (next !== inv.status) {
      const deposits = await this.deposits(db, invoiceId);
      await enqueueWebhook(db, inv.merchant_id, invoiceId, `invoice.${next}`, this.serialize(after, deposits));
    } else if (BigInt(after.amount_received) > BigInt(inv.amount_received)) {
      // More money confirmed without a status change (e.g. a top-up after `paid`): tell the merchant.
      const deposits = await this.deposits(db, invoiceId);
      await enqueueWebhook(db, inv.merchant_id, invoiceId, 'invoice.updated', this.serialize(after, deposits));
    }
    return after;
  }

  /** Merchant/admin cancels an invoice that has received nothing yet. */
  async cancel(invoiceId: string, merchantId?: string): Promise<InvoiceRow> {
    return withTx(async (db) => {
      const { rows } = await db.query<InvoiceRow>(
        `SELECT * FROM invoices WHERE id = $1 ${merchantId ? 'AND merchant_id = $2' : ''} FOR UPDATE`,
        merchantId ? [invoiceId, merchantId] : [invoiceId],
      );
      const inv = rows[0];
      if (!inv) throw new InvoiceError('Invoice not found', 404, 'not_found');
      const { rows: d } = await db.query('SELECT 1 FROM deposits WHERE invoice_id = $1 AND status <> $2 LIMIT 1', [invoiceId, 'orphaned']);
      if (!['pending', 'expired'].includes(inv.status) || d.length) {
        throw new InvoiceError('Only invoices without payments can be cancelled', 409, 'not_cancellable');
      }
      const { rows: up } = await db.query<InvoiceRow>(
        `UPDATE invoices SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
        [invoiceId],
      );
      await this.releaseAddress(db, up[0]!);
      await enqueueWebhook(db, inv.merchant_id, invoiceId, 'invoice.cancelled', this.serialize(up[0]!, []));
      return up[0]!;
    });
  }

  /**
   * Admin resolution for an underpaid / partially paid invoice: accept what was received (confirmed only)
   * as full payment. The received amount is credited to the merchant minus fee.
   */
  async markPaidManually(invoiceId: string): Promise<InvoiceRow> {
    return withTx(async (db) => {
      const inv = await this.recompute(db, invoiceId);
      if (inv.status === 'paid') return inv;
      if (BigInt(inv.amount_received) === 0n) throw new InvoiceError('Nothing confirmed on this invoice yet', 409, 'nothing_received');
      await db.query(`UPDATE invoices SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1`, [invoiceId]);
      const { rows } = await db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
      await this.releaseAddress(db, rows[0]!);
      await this.deps.ledger.creditInvoice(db, rows[0]!);
      const after = (await db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0]!;
      await enqueueWebhook(db, inv.merchant_id, invoiceId, 'invoice.paid', this.serialize(after, await this.deposits(db, invoiceId)));
      return after;
    });
  }

  /** Moves pending invoices past their deadline to `expired`. */
  async expireDue(): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM invoices WHERE status = 'pending' AND expires_at < now() LIMIT 500`,
    );
    for (const r of rows) await withTx((db) => this.recompute(db, r.id));
    return rows.length;
  }

  // ------------------------------------------------------------------ serialization

  serialize(inv: InvoiceRow, deposits?: DepositRow[]) {
    const asset = inv.asset ? findAsset(this.deps.registry, inv.asset) : undefined;
    const fmt = (v: string | null) => (v === null || !asset ? null : fromBaseUnits(v, asset.decimals));
    return {
      id: inv.id,
      order_id: inv.order_id,
      customer_id: inv.customer_id,
      description: inv.description,
      status: inv.status,
      price_amount: trimDecimal(inv.price_amount),
      price_currency: inv.price_currency,
      asset: inv.asset,
      network: inv.chain,
      address: inv.address,
      memo: inv.memo,
      pay_amount: fmt(inv.pay_amount),
      amount_received: fmt(inv.amount_received),
      amount_pending: fmt(inv.amount_pending),
      rate: inv.rate && trimDecimal(inv.rate),
      fee_amount: fmt(inv.fee_amount),
      net_amount: inv.status === 'paid' && asset ? fromBaseUnits(BigInt(inv.amount_received) - BigInt(inv.fee_amount), asset.decimals) : null,
      is_late: inv.is_late,
      payment_url: `${this.publicBaseUrl}/pay/${inv.id}`,
      success_url: inv.success_url,
      cancel_url: inv.cancel_url,
      metadata: inv.metadata,
      expires_at: inv.expires_at.toISOString(),
      paid_at: inv.paid_at?.toISOString() ?? null,
      created_at: inv.created_at.toISOString(),
      deposits: deposits?.map((d) => ({
        tx_hash: d.tx_hash,
        from: d.from_address,
        amount: asset ? fromBaseUnits(d.amount, asset.decimals) : d.amount,
        confirmations: d.confirmations,
        status: d.status,
        detected_at: d.detected_at.toISOString(),
      })),
    };
  }

  availableAssets() {
    return enabledAssets(this.deps.registry).map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      network: a.chain,
      network_name: this.deps.registry.chains[a.chain].name,
      decimals: a.decimals,
      contract: a.contract ?? null,
      confirmations: this.deps.registry.chains[a.chain].confirmations,
    }));
  }
}

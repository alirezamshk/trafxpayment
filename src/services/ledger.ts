import type pg from 'pg';
import { config } from '../config.js';
import { pool, withTx, type Queryable } from '../db.js';
import { findAsset, type Registry } from '../chains/assets.js';
import { fromBaseUnits as formatUnits } from '../lib/amount.js';
import { AssetSettingsService } from './asset-settings.js';
import { enqueueWebhook } from './webhooks.js';

/**
 * Fee for `gross` base units at `feePercent` (e.g. "1.5" = 1.5%), rounded down to the unit.
 * fee_percent has 3 decimals, so work in thousandths of a percent.
 */
export function computeFee(gross: bigint, feePercent: string | number): bigint {
  const milli = BigInt(Math.round(Number(feePercent) * 1000));
  return (gross * milli) / 100_000n;
}

/**
 * Most recent scheduled settlement moment at or before `now` (UTC), or null for manual schedules.
 */
export function lastScheduledSettlement(
  schedule: 'daily' | 'weekly' | 'manual',
  weekday: number,
  hourUtc: number,
  now: Date,
): Date | null {
  if (schedule === 'manual') return null;
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (t > now) t.setUTCDate(t.getUTCDate() - 1);
  if (schedule === 'weekly') {
    while (t.getUTCDay() !== weekday) t.setUTCDate(t.getUTCDate() - 1);
  }
  return t;
}

export function isSettlementDue(
  m: { settlement_schedule: 'daily' | 'weekly' | 'manual'; settlement_weekday: number; last_settled_at: Date | null; created_at: Date },
  hourUtc: number,
  now: Date,
): boolean {
  const scheduled = lastScheduledSettlement(m.settlement_schedule, m.settlement_weekday, hourUtc, now);
  if (!scheduled || scheduled < m.created_at) return false;
  return !m.last_settled_at || m.last_settled_at < scheduled;
}

export interface PayoutRow {
  id: string;
  merchant_id: string;
  asset: string;
  chain: string;
  address: string;
  amount: string;
  fee: string;
  status: 'pending_approval' | 'approved' | 'sending' | 'sent' | 'completed' | 'failed' | 'rejected';
  tx_hash: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  approved_at: Date | null;
  sent_at: Date | null;
  completed_at: Date | null;
}

export class LedgerService {
  readonly settings: AssetSettingsService;

  constructor(
    private readonly registry: Registry,
    private readonly requireApproval = config.PAYOUT_REQUIRE_APPROVAL,
    private readonly settlementHour = config.SETTLEMENT_HOUR_UTC,
  ) {
    this.settings = new AssetSettingsService(registry);
  }

  /**
   * Credits a paid invoice to the merchant (gross payment minus platform fee). Idempotent: only the
   * not-yet-credited part of amount_received is booked, so late top-ups after `paid` are credited too.
   * Must run inside the transaction holding the invoice row lock.
   */
  async creditInvoice(
    db: pg.PoolClient,
    inv: { id: string; merchant_id: string; asset: string | null; amount_received: string },
  ): Promise<bigint> {
    if (!inv.asset) return 0n;
    const { rows } = await db.query<{ credited: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS credited FROM ledger_entries WHERE invoice_id = $1 AND type = 'payment'`,
      [inv.id],
    );
    const delta = BigInt(inv.amount_received) - BigInt(rows[0]!.credited);
    if (delta <= 0n) return 0n;

    const { rows: m } = await db.query<{ fee_percent: string }>('SELECT fee_percent FROM merchants WHERE id = $1', [inv.merchant_id]);
    const feePercent = m[0]!.fee_percent;
    const fee = computeFee(delta, feePercent);

    await db.query(
      `INSERT INTO ledger_entries (merchant_id, asset, amount, type, invoice_id) VALUES ($1, $2, $3, 'payment', $4)`,
      [inv.merchant_id, inv.asset, delta.toString(), inv.id],
    );
    if (fee > 0n) {
      await db.query(
        `INSERT INTO ledger_entries (merchant_id, asset, amount, type, invoice_id, note) VALUES ($1, $2, $3, 'fee', $4, $5)`,
        [inv.merchant_id, inv.asset, (-fee).toString(), inv.id, `${feePercent}%`],
      );
    }
    await db.query(
      `UPDATE invoices SET fee_amount = fee_amount + $2, fee_percent = $3 WHERE id = $1`,
      [inv.id, fee.toString(), feePercent],
    );
    return delta - fee;
  }

  async balances(db: Queryable, merchantId: string): Promise<{ asset: string; balance: bigint }[]> {
    const { rows } = await db.query<{ asset: string; balance: string }>(
      `SELECT asset, SUM(amount) AS balance FROM ledger_entries WHERE merchant_id = $1 GROUP BY asset ORDER BY asset`,
      [merchantId],
    );
    return rows.map((r) => ({ asset: r.asset, balance: BigInt(r.balance) }));
  }

  async platformSummary(db: Queryable) {
    const { rows } = await db.query<{ asset: string; fees: string; payout_fees: string; merchant_balances: string; volume: string }>(
      `SELECT asset,
              -COALESCE(SUM(amount) FILTER (WHERE type = 'fee'), 0) AS fees,
              -COALESCE(SUM(amount) FILTER (WHERE type = 'payout_fee'), 0)
                - COALESCE(SUM(amount) FILTER (WHERE type = 'payout_reversal' AND note LIKE 'fee:%'), 0) AS payout_fees,
              COALESCE(SUM(amount), 0) AS merchant_balances,
              COALESCE(SUM(amount) FILTER (WHERE type = 'payment'), 0) AS volume
       FROM ledger_entries GROUP BY asset ORDER BY asset`,
    );
    return rows;
  }

  async entries(db: Queryable, merchantId: string, limit = 100) {
    const { rows } = await db.query(
      `SELECT id, asset, amount, type, invoice_id, payout_id, note, created_at FROM ledger_entries
       WHERE merchant_id = $1 ORDER BY id DESC LIMIT $2`,
      [merchantId, limit],
    );
    return rows;
  }

  // ------------------------------------------------------------------ payouts

  /**
   * Moves the merchant's whole available balance of `asset` into a payout to their configured address,
   * minus the per-asset network fee (charged to the merchant). Funds are debited from the ledger
   * immediately (reserved), and restored in full if the payout is rejected or fails.
   */
  async createPayout(db: pg.PoolClient, merchantId: string, asset: string, opts: { respectMinimum: boolean }): Promise<PayoutRow | null> {
    const def = findAsset(this.registry, asset);
    if (!def) throw new Error(`Unknown asset ${asset}`);
    // Serialize payouts per merchant.
    await db.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [merchantId]);
    const { rows: addr } = await db.query<{ address: string; min_amount: string }>(
      'SELECT address, min_amount FROM payout_addresses WHERE merchant_id = $1 AND asset = $2',
      [merchantId, asset],
    );
    if (!addr[0]) return null;
    const { rows: bal } = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE merchant_id = $1 AND asset = $2`,
      [merchantId, asset],
    );
    const balance = BigInt(bal[0]!.balance);
    if (balance <= 0n) return null;
    if (opts.respectMinimum && balance < BigInt(addr[0].min_amount)) return null;
    const { payoutFee } = await this.settings.get(db, asset);
    const amount = balance - payoutFee;
    if (amount <= 0n) return null;

    const status = this.requireApproval ? 'pending_approval' : 'approved';
    const { rows } = await db.query<PayoutRow>(
      `INSERT INTO payouts (merchant_id, asset, chain, address, amount, fee, status, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'approved' THEN now() END) RETURNING *`,
      [merchantId, asset, def.chain, addr[0].address, amount.toString(), payoutFee.toString(), status],
    );
    const payout = rows[0]!;
    await db.query(
      `INSERT INTO ledger_entries (merchant_id, asset, amount, type, payout_id) VALUES ($1, $2, $3, 'payout', $4)`,
      [merchantId, asset, (-amount).toString(), payout.id],
    );
    if (payoutFee > 0n) {
      await db.query(
        `INSERT INTO ledger_entries (merchant_id, asset, amount, type, payout_id, note) VALUES ($1, $2, $3, 'payout_fee', $4, 'network fee')`,
        [merchantId, asset, (-payoutFee).toString(), payout.id],
      );
    }
    await enqueueWebhook(db, merchantId, null, 'payout.created', this.serializePayout(payout));
    return payout;
  }

  /** Runs scheduled settlements for every merchant that is due. Returns the payouts created. */
  async runSettlements(now = new Date()): Promise<PayoutRow[]> {
    const { rows: merchants } = await pool.query<{
      id: string;
      settlement_schedule: 'daily' | 'weekly' | 'manual';
      settlement_weekday: number;
      last_settled_at: Date | null;
      created_at: Date;
    }>(`SELECT id, settlement_schedule, settlement_weekday, last_settled_at, created_at FROM merchants WHERE is_active`);

    const created: PayoutRow[] = [];
    for (const m of merchants) {
      if (!isSettlementDue(m, this.settlementHour, now)) continue;
      await withTx(async (db) => {
        const { rows: assets } = await db.query<{ asset: string }>('SELECT asset FROM payout_addresses WHERE merchant_id = $1', [m.id]);
        for (const a of assets) {
          const p = await this.createPayout(db, m.id, a.asset, { respectMinimum: true });
          if (p) created.push(p);
        }
        await db.query('UPDATE merchants SET last_settled_at = $2 WHERE id = $1', [m.id, now]);
      });
    }
    return created;
  }

  async approvePayout(id: string): Promise<boolean> {
    const r = await pool.query(
      `UPDATE payouts SET status = 'approved', approved_at = now() WHERE id = $1 AND status = 'pending_approval'`,
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Rejects (admin) or fails (signer) a payout and returns the reserved funds to the merchant balance. */
  async cancelPayout(id: string, status: 'rejected' | 'failed', error?: string): Promise<boolean> {
    return withTx(async (db) => {
      // `sending` can be rejected only after an admin verified on the explorer that nothing was broadcast.
      const allowed = status === 'rejected' ? ['pending_approval', 'approved', 'sending'] : ['approved', 'sending'];
      const { rows } = await db.query<PayoutRow>(
        `UPDATE payouts SET status = $2, error = $3 WHERE id = $1 AND status = ANY($4) RETURNING *`,
        [id, status, error ?? null, allowed],
      );
      const p = rows[0];
      if (!p) return false;
      await db.query(
        `INSERT INTO ledger_entries (merchant_id, asset, amount, type, payout_id, note)
         VALUES ($1, $2, $3, 'payout_reversal', $4, $5)`,
        [p.merchant_id, p.asset, p.amount, p.id, status],
      );
      if (BigInt(p.fee) > 0n) {
        await db.query(
          `INSERT INTO ledger_entries (merchant_id, asset, amount, type, payout_id, note)
           VALUES ($1, $2, $3, 'payout_reversal', $4, $5)`,
          [p.merchant_id, p.asset, p.fee, p.id, `fee:${status}`],
        );
      }
      await enqueueWebhook(db, p.merchant_id, null, `payout.${status}`, this.serializePayout(p));
      return true;
    });
  }

  async adjust(merchantId: string, asset: string, amount: bigint, note: string): Promise<void> {
    await pool.query(
      `INSERT INTO ledger_entries (merchant_id, asset, amount, type, note) VALUES ($1, $2, $3, 'adjustment', $4)`,
      [merchantId, asset, amount.toString(), note],
    );
  }

  serializePayout(p: PayoutRow) {
    const def = findAsset(this.registry, p.asset);
    const amount = def ? formatUnits(p.amount, def.decimals) : p.amount;
    return {
      id: p.id,
      asset: p.asset,
      network: p.chain,
      address: p.address,
      amount,
      fee: def ? formatUnits(p.fee ?? '0', def.decimals) : p.fee,
      status: p.status,
      tx_hash: p.tx_hash,
      error: p.error,
      created_at: p.created_at.toISOString(),
      sent_at: p.sent_at?.toISOString() ?? null,
      completed_at: p.completed_at?.toISOString() ?? null,
    };
  }
}

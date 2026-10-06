import { config } from '../config.js';
import { pool } from '../db.js';
import { findAsset, type Registry } from '../chains/assets.js';
import type { LedgerService, PayoutRow } from '../services/ledger.js';
import { enqueueWebhook } from '../services/webhooks.js';
import type { Logger, Watcher } from '../watchers/types.js';
import type { ChainSigner } from './types.js';

const STUCK_MS = 30 * 60_000;

/** Moves confirmed deposits from per-invoice addresses to the hot wallet (EVM + TRON). */
export class SweepJob implements Watcher {
  readonly name = 'sweep';
  readonly intervalMs = config.SWEEP_INTERVAL_MS;

  constructor(
    private readonly signers: ChainSigner[],
    private readonly registry: Registry,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<void> {
    for (const s of this.signers) {
      if (s.chain === 'ton') continue;
      try {
        await this.sweepChain(s);
      } catch (err) {
        this.log.error({ chain: s.chain, err: (err as Error).message }, 'sweep failed');
      }
    }
  }

  private async sweepChain(signer: ChainSigner): Promise<void> {
    const { rows } = await pool.query<{ to_address: string; asset: string; derivation_index: string }>(
      `SELECT d.to_address, d.asset, MIN(i.derivation_index) AS derivation_index
       FROM deposits d
       JOIN invoices i ON i.chain = d.chain AND lower(i.address) = lower(d.to_address) AND i.memo IS NULL
       WHERE d.chain = $1 AND d.status = 'confirmed' AND d.swept_at IS NULL
       GROUP BY d.to_address, d.asset
       LIMIT 50`,
      [signer.chain],
    );
    for (const g of rows) {
      const asset = findAsset(this.registry, g.asset);
      if (!asset) continue;
      if (await this.inFlight(signer, g.to_address, g.asset)) continue;

      const record = async (kind: 'gas_topup' | 'sweep', hash: string, amount: bigint) => {
        await pool.query(
          `INSERT INTO sweeps (chain, address, asset, kind, tx_hash, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
          [signer.chain, g.to_address, g.asset, kind, hash, amount.toString()],
        );
        this.log.info({ chain: signer.chain, address: g.to_address, asset: g.asset, kind, tx: hash }, 'sweep tx sent');
      };
      const result = await signer.sweep(Number(g.derivation_index), g.to_address, asset, record);
      if (result === 'empty') await this.markSwept(signer.chain, g.to_address, g.asset, new Date());
    }
  }

  /** True while a previous gas top-up or sweep for this address is unresolved. */
  private async inFlight(signer: ChainSigner, address: string, asset: string): Promise<boolean> {
    const { rows } = await pool.query<{ id: string; kind: string; tx_hash: string; created_at: Date }>(
      `SELECT id, kind, tx_hash, created_at FROM sweeps WHERE chain = $1 AND address = $2 AND asset = $3 AND status = 'sent'`,
      [signer.chain, address, asset],
    );
    let busy = false;
    for (const s of rows) {
      const state = await signer.txState(s.tx_hash);
      if (state === 'success') {
        await pool.query(`UPDATE sweeps SET status = 'confirmed' WHERE id = $1`, [s.id]);
        if (s.kind === 'sweep') await this.markSwept(signer.chain, address, asset, s.created_at);
      } else if (state === 'failed' || (state === 'unknown' && Date.now() - s.created_at.getTime() > STUCK_MS)) {
        await pool.query(`UPDATE sweeps SET status = 'failed', error = $2 WHERE id = $1`, [s.id, state]);
        this.log.warn({ chain: signer.chain, tx: s.tx_hash, state }, 'sweep tx failed');
      } else {
        busy = true;
      }
    }
    return busy;
  }

  private async markSwept(chain: string, address: string, asset: string, before: Date) {
    await pool.query(
      `UPDATE deposits SET swept_at = now()
       WHERE chain = $1 AND lower(to_address) = lower($2) AND asset = $3 AND status = 'confirmed'
         AND swept_at IS NULL AND detected_at <= $4`,
      [chain, address, asset, before],
    );
  }
}

/** Broadcasts approved payouts from the hot wallet and tracks them to completion. */
export class PayoutJob implements Watcher {
  readonly name = 'payouts';
  readonly intervalMs = 20_000;
  private readonly byChain: Map<string, ChainSigner>;

  constructor(
    signers: ChainSigner[],
    private readonly registry: Registry,
    private readonly ledger: LedgerService,
    private readonly log: Logger,
  ) {
    this.byChain = new Map(signers.map((s) => [s.chain, s]));
  }

  async tick(): Promise<void> {
    await this.trackSent();
    await this.sendApproved();
  }

  private async sendApproved(): Promise<void> {
    const { rows } = await pool.query<PayoutRow>(`SELECT * FROM payouts WHERE status = 'approved' ORDER BY approved_at LIMIT 20`);
    for (const p of rows) {
      const signer = this.byChain.get(p.chain);
      const asset = findAsset(this.registry, p.asset);
      if (!signer || !asset) continue;
      if (!signer.validateAddress(p.address)) {
        await this.ledger.cancelPayout(p.id, 'failed', 'invalid payout address');
        continue;
      }
      if ('serial' in signer && signer.serial) {
        const { rows: busy } = await pool.query(`SELECT 1 FROM payouts WHERE chain = $1 AND status IN ('sending','sent') LIMIT 1`, [p.chain]);
        if (busy.length) continue;
      }

      let prepared;
      try {
        prepared = await signer.preparePayout(asset, p.address, BigInt(p.amount));
      } catch (err) {
        const attempts = p.attempts + 1;
        const msg = (err as Error).message;
        if (attempts >= 5) await this.ledger.cancelPayout(p.id, 'failed', msg);
        else await pool.query(`UPDATE payouts SET attempts = $2, error = $3 WHERE id = $1`, [p.id, attempts, msg]);
        this.log.warn({ payout: p.id, err: msg }, 'payout preparation failed');
        continue;
      }

      // Persist the hash BEFORE broadcasting: after a crash we look the tx up instead of paying twice.
      const claimed = await pool.query(
        `UPDATE payouts SET status = 'sending', tx_hash = $2, attempts = attempts + 1 WHERE id = $1 AND status = 'approved'`,
        [p.id, prepared.hash],
      );
      if (!claimed.rowCount) continue;
      try {
        await prepared.broadcast();
        await pool.query(`UPDATE payouts SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [p.id]);
        this.log.info({ payout: p.id, chain: p.chain, tx: prepared.hash }, 'payout sent');
      } catch (err) {
        // Unknown outcome: leave it in `sending`; trackSent() resolves it from the chain.
        await pool.query(`UPDATE payouts SET error = $2 WHERE id = $1`, [p.id, (err as Error).message]);
        this.log.error({ payout: p.id, err: (err as Error).message }, 'payout broadcast error');
      }
    }
  }

  private async trackSent(): Promise<void> {
    const { rows } = await pool.query<PayoutRow>(`SELECT * FROM payouts WHERE status IN ('sending', 'sent') AND tx_hash IS NOT NULL`);
    for (const p of rows) {
      const signer = this.byChain.get(p.chain);
      if (!signer) continue;
      const state = await signer.txState(p.tx_hash!).catch(() => 'pending' as const);
      if (state === 'success') {
        const { rows: done } = await pool.query<PayoutRow>(
          `UPDATE payouts SET status = 'completed', completed_at = now(), sent_at = COALESCE(sent_at, now())
           WHERE id = $1 AND status IN ('sending','sent') RETURNING *`,
          [p.id],
        );
        if (done[0]) await enqueueWebhook(pool, p.merchant_id, null, 'payout.completed', this.ledger.serializePayout(done[0]));
        this.log.info({ payout: p.id, tx: p.tx_hash }, 'payout completed');
      } else if (state === 'failed') {
        await this.ledger.cancelPayout(p.id, 'failed', 'transaction reverted on chain');
      } else if (state === 'unknown' && p.status === 'sending' && Date.now() - p.created_at.getTime() > STUCK_MS) {
        // Never auto-retry: an admin checks the explorer and rejects (refunds the balance) if it truly never landed.
        await pool.query(`UPDATE payouts SET error = 'not found on chain - verify manually, then reject to refund' WHERE id = $1`, [p.id]);
      }
    }
  }
}

import { config } from '../config.js';
import { pool } from '../db.js';
import { findAsset, type AssetDef, type Registry } from '../chains/assets.js';
import type { AssetSettingsService } from '../services/asset-settings.js';
import type { LedgerService, PayoutRow } from '../services/ledger.js';
import { enqueueWebhook } from '../services/webhooks.js';
import type { Logger, Watcher } from '../watchers/types.js';
import type { ChainSigner } from './types.js';

const STUCK_MS = 30 * 60_000;

/**
 * Moves confirmed deposits from deposit addresses to the hot wallet (EVM + TRON).
 * An address is swept once its unswept balance of an asset reaches that asset's sweep threshold
 * (expensive TRC20/ERC20 transfers are batched this way), or earlier when approved payouts need
 * more than the hot wallet holds — then the fullest addresses are swept first.
 */
export class SweepJob implements Watcher {
  readonly name = 'sweep';
  readonly intervalMs = config.SWEEP_INTERVAL_MS;

  constructor(
    private readonly signers: ChainSigner[],
    private readonly registry: Registry,
    private readonly settings: AssetSettingsService,
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

  /** How much more the hot wallet needs to cover approved payouts of `asset` (0 if enough). */
  private async shortfall(signer: ChainSigner, asset: AssetDef): Promise<bigint> {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount + fee), 0) AS total FROM payouts WHERE chain = $1 AND asset = $2 AND status = 'approved'`,
      [signer.chain, asset.id],
    );
    const needed = BigInt(rows[0]!.total);
    if (needed === 0n) return 0n;
    const have = await signer.hotBalance(asset);
    return have === null || have >= needed ? 0n : needed - have;
  }

  private async sweepChain(signer: ChainSigner): Promise<void> {
    const family = signer.chain === 'tron' ? 'tron' : 'evm';
    const { rows } = await pool.query<{ to_address: string; asset: string; derivation_index: string; unswept: string }>(
      `SELECT d.to_address, d.asset, MIN(da.derivation_index) AS derivation_index, SUM(d.amount) AS unswept
       FROM deposits d
       JOIN deposit_addresses da ON da.family = $2 AND lower(da.address) = lower(d.to_address)
       WHERE d.chain = $1 AND d.status = 'confirmed' AND d.swept_at IS NULL
       GROUP BY d.to_address, d.asset
       ORDER BY SUM(d.amount) DESC`,
      [signer.chain, family],
    );

    const perAsset = new Map<string, { threshold: bigint; shortfall: bigint }>();
    for (const g of rows) {
      const asset = findAsset(this.registry, g.asset);
      if (!asset) continue;
      let st = perAsset.get(asset.id);
      if (!st) {
        const { sweepThreshold } = await this.settings.get(pool, asset.id);
        st = { threshold: sweepThreshold, shortfall: await this.shortfall(signer, asset) };
        perAsset.set(asset.id, st);
      }
      const unswept = BigInt(g.unswept);
      const forced = st.shortfall > 0n;
      if (!forced && unswept < st.threshold) continue; // keep accumulating
      if (forced) st.shortfall -= unswept < st.shortfall ? unswept : st.shortfall;

      if (await this.inFlight(signer, g.to_address, asset, Number(g.derivation_index))) continue;

      const record = async (kind: 'gas_topup' | 'sweep' | 'gas_return', hash: string, amount: bigint) => {
        await pool.query(
          `INSERT INTO sweeps (chain, address, asset, kind, tx_hash, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
          [signer.chain, g.to_address, g.asset, kind, hash, amount.toString()],
        );
        this.log.info(
          { chain: signer.chain, address: g.to_address, asset: g.asset, kind, tx: hash, forced },
          'sweep tx sent',
        );
      };
      const result = await signer.sweep(Number(g.derivation_index), g.to_address, asset, record);
      if (result === 'empty') await this.markSwept(signer.chain, g.to_address, g.asset, new Date());
    }
  }

  /** True while a previous gas top-up or sweep for this address is unresolved. */
  private async inFlight(signer: ChainSigner, address: string, asset: AssetDef, index: number): Promise<boolean> {
    const { rows } = await pool.query<{ id: string; kind: string; tx_hash: string; created_at: Date }>(
      `SELECT id, kind, tx_hash, created_at FROM sweeps WHERE chain = $1 AND address = $2 AND asset = $3 AND status = 'sent'`,
      [signer.chain, address, asset.id],
    );
    let busy = false;
    for (const s of rows) {
      const state = await signer.txState(s.tx_hash);
      if (state === 'success') {
        await pool.query(`UPDATE sweeps SET status = 'confirmed' WHERE id = $1`, [s.id]);
        if (s.kind === 'sweep') {
          await this.markSwept(signer.chain, address, asset.id, s.created_at);
          if (asset.contract && signer.reclaimGas) {
            await signer
              .reclaimGas(index, address, async (kind, hash, amount) => {
                // Logged as already confirmed: nothing depends on tracking it further.
                await pool.query(
                  `INSERT INTO sweeps (chain, address, asset, kind, tx_hash, amount, status) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')`,
                  [signer.chain, address, asset.id, kind, hash, amount.toString()],
                );
                this.log.info({ chain: signer.chain, address, kind, tx: hash, amount: amount.toString() }, 'leftover gas returned');
              })
              .catch((err: Error) => this.log.warn({ chain: signer.chain, address, err: err.message }, 'gas reclaim failed'));
          }
        }
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

      // Wait (without consuming an attempt) until sweeps have filled the hot wallet.
      const have = await signer.hotBalance(asset).catch(() => null);
      const need = BigInt(p.amount) + (asset.contract ? 0n : BigInt(p.fee));
      if (have !== null && have < need) {
        await pool.query(`UPDATE payouts SET error = $2 WHERE id = $1`, [p.id, 'waiting for hot wallet liquidity (sweeping deposits)']);
        continue;
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

/**
 * Keeps hot wallets small: whatever exceeds an asset's hot_max (plus approved payouts still to be
 * sent) is transferred to the operator's cold wallet. A transfer is only made when the surplus is
 * at least 10% of hot_max, so it does not trickle out on every payment.
 */
export class ColdStorageJob implements Watcher {
  readonly name = 'cold-storage';
  readonly intervalMs = config.COLD_INTERVAL_MS;

  constructor(
    private readonly signers: ChainSigner[],
    private readonly coldAddress: (chain: string) => string | undefined,
    private readonly registry: Registry,
    private readonly settings: AssetSettingsService,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<void> {
    for (const signer of this.signers) {
      const cold = this.coldAddress(signer.chain);
      if (!cold) continue;
      for (const asset of this.registry.assets.filter((a) => a.chain === signer.chain)) {
        try {
          await this.move(signer, asset, cold);
        } catch (err) {
          this.log.error({ chain: signer.chain, asset: asset.id, err: (err as Error).message }, 'cold transfer failed');
        }
      }
    }
  }

  private async move(signer: ChainSigner, asset: AssetDef, cold: string): Promise<void> {
    // Resolve the previous transfer first; never stack transfers.
    const { rows: open } = await pool.query<{ id: string; tx_hash: string; created_at: Date }>(
      `SELECT id, tx_hash, created_at FROM sweeps WHERE chain = $1 AND asset = $2 AND kind = 'to_cold' AND status = 'sent'`,
      [signer.chain, asset.id],
    );
    for (const s of open) {
      const state = await signer.txState(s.tx_hash);
      if (state === 'pending' || (state === 'unknown' && Date.now() - s.created_at.getTime() < STUCK_MS)) return;
      await pool.query(`UPDATE sweeps SET status = $2 WHERE id = $1`, [s.id, state === 'success' ? 'confirmed' : 'failed']);
    }

    const balance = await signer.hotBalance(asset);
    if (balance === null) return;
    const { hotMax } = await this.settings.get(pool, asset.id);
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount + fee), 0) AS total FROM payouts
       WHERE chain = $1 AND asset = $2 AND status IN ('pending_approval', 'approved', 'sending')`,
      [signer.chain, asset.id],
    );
    const keep = hotMax + BigInt(rows[0]!.total);
    const surplus = balance - keep;
    if (surplus <= 0n || surplus < hotMax / 10n) return;

    const tx = await signer.preparePayout(asset, cold, surplus);
    await pool.query(
      `INSERT INTO sweeps (chain, address, asset, kind, tx_hash, amount) VALUES ($1, $2, $3, 'to_cold', $4, $5)`,
      [signer.chain, signer.hotAddress, asset.id, tx.hash, surplus.toString()],
    );
    await tx.broadcast();
    this.log.info({ chain: signer.chain, asset: asset.id, amount: surplus.toString(), tx: tx.hash }, 'surplus moved to cold wallet');
  }
}

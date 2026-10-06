import type { Queryable } from '../db.js';
import { findAsset, type Registry } from '../chains/assets.js';
import { fromBaseUnits, toBaseUnits } from '../lib/amount.js';

/**
 * Defaults (in whole units) until the operator changes them in the admin panel.
 * sweep_threshold: funds stay on deposit addresses until this much has accumulated (0 = sweep at once).
 * payout_fee: network cost charged to the merchant per settlement payout.
 * TRC20 / ERC20 transfers are expensive, so they wait; BSC/Polygon/TRX transfers cost cents.
 */
const DEFAULTS: Record<string, { sweep: string; payoutFee: string }> = {
  USDT_TRC20: { sweep: '100', payoutFee: '1' },
  TRX: { sweep: '0', payoutFee: '1' },
  USDT_ERC20: { sweep: '500', payoutFee: '5' },
  ETH: { sweep: '0.2', payoutFee: '0.002' },
  USDT_BEP20: { sweep: '0', payoutFee: '0.1' },
  BNB: { sweep: '0', payoutFee: '0.0002' },
  USDT_POLYGON: { sweep: '0', payoutFee: '0.1' },
  POL: { sweep: '0', payoutFee: '0.05' },
  TON: { sweep: '0', payoutFee: '0.05' },
  USDT_TON: { sweep: '0', payoutFee: '0.2' },
};

export interface AssetSettings {
  asset: string;
  sweepThreshold: bigint;
  payoutFee: bigint;
}

export class AssetSettingsService {
  constructor(private readonly registry: Registry) {}

  private defaults(asset: string): AssetSettings {
    const def = findAsset(this.registry, asset);
    const d = DEFAULTS[asset] ?? { sweep: '0', payoutFee: '0' };
    if (!def) return { asset, sweepThreshold: 0n, payoutFee: 0n };
    return { asset, sweepThreshold: toBaseUnits(d.sweep, def.decimals), payoutFee: toBaseUnits(d.payoutFee, def.decimals) };
  }

  async get(db: Queryable, asset: string): Promise<AssetSettings> {
    const { rows } = await db.query<{ sweep_threshold: string; payout_fee: string }>(
      'SELECT sweep_threshold, payout_fee FROM asset_settings WHERE asset = $1',
      [asset],
    );
    const r = rows[0];
    return r ? { asset, sweepThreshold: BigInt(r.sweep_threshold), payoutFee: BigInt(r.payout_fee) } : this.defaults(asset);
  }

  async set(db: Queryable, asset: string, sweepThreshold: bigint, payoutFee: bigint): Promise<void> {
    await db.query(
      `INSERT INTO asset_settings (asset, sweep_threshold, payout_fee) VALUES ($1, $2, $3)
       ON CONFLICT (asset) DO UPDATE SET sweep_threshold = EXCLUDED.sweep_threshold,
         payout_fee = EXCLUDED.payout_fee, updated_at = now()`,
      [asset, sweepThreshold.toString(), payoutFee.toString()],
    );
  }

  /** Human-readable view for the panels. */
  async view(db: Queryable, assets: string[]) {
    const out = [];
    for (const asset of assets) {
      const def = findAsset(this.registry, asset)!;
      const s = await this.get(db, asset);
      out.push({
        asset,
        sweep_threshold: fromBaseUnits(s.sweepThreshold, def.decimals),
        payout_fee: fromBaseUnits(s.payoutFee, def.decimals),
      });
    }
    return out;
  }
}

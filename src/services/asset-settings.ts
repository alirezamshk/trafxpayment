import type { Queryable } from '../db.js';
import { findAsset, type Registry } from '../chains/assets.js';
import { fromBaseUnits, toBaseUnits } from '../lib/amount.js';

/**
 * Per-asset operator settings, editable in the admin panel. Defaults (whole units) apply until changed.
 * - sweepThreshold: funds stay on deposit addresses until this much accumulated (0 = sweep at once)
 * - payoutFee:      network cost charged to the merchant per settlement payout
 * - minAmount:      smallest invoice payable in this asset; smaller invoices must use another network
 * - depositFee:     network cost per incoming payment (paid by the customer or merchant, see fee_payer)
 * - hotMax:         hot-wallet balance above which the surplus is moved to the cold wallet
 */
const DEFAULTS: Record<string, { sweep: string; payoutFee: string; min: string; depositFee: string; hotMax: string }> = {
  USDT_TRC20: { sweep: '100', payoutFee: '1', min: '10', depositFee: '1', hotMax: '2000' },
  TRX: { sweep: '0', payoutFee: '1', min: '10', depositFee: '0', hotMax: '20000' },
  USDT_ERC20: { sweep: '500', payoutFee: '5', min: '50', depositFee: '3', hotMax: '5000' },
  ETH: { sweep: '0.2', payoutFee: '0.002', min: '0.01', depositFee: '0.001', hotMax: '2' },
  USDT_BEP20: { sweep: '0', payoutFee: '0.1', min: '1', depositFee: '0.05', hotMax: '2000' },
  BNB: { sweep: '0', payoutFee: '0.0002', min: '0.005', depositFee: '0', hotMax: '5' },
  USDT_POLYGON: { sweep: '0', payoutFee: '0.1', min: '1', depositFee: '0.05', hotMax: '2000' },
  POL: { sweep: '0', payoutFee: '0.05', min: '2', depositFee: '0', hotMax: '5000' },
  TON: { sweep: '0', payoutFee: '0.05', min: '0.5', depositFee: '0', hotMax: '1000' },
  USDT_TON: { sweep: '0', payoutFee: '0.2', min: '1', depositFee: '0.1', hotMax: '2000' },
};

export interface AssetSettings {
  asset: string;
  sweepThreshold: bigint;
  payoutFee: bigint;
  minAmount: bigint;
  depositFee: bigint;
  hotMax: bigint;
}

export type AssetSettingsInput = Omit<AssetSettings, 'asset'>;

interface Row {
  sweep_threshold: string;
  payout_fee: string;
  min_amount: string | null;
  deposit_fee: string | null;
  hot_max: string | null;
}

export class AssetSettingsService {
  constructor(private readonly registry: Registry) {}

  defaults(asset: string): AssetSettings {
    const def = findAsset(this.registry, asset);
    const d = DEFAULTS[asset] ?? { sweep: '0', payoutFee: '0', min: '0', depositFee: '0', hotMax: '0' };
    const u = (v: string) => (def ? toBaseUnits(v, def.decimals) : 0n);
    return {
      asset,
      sweepThreshold: u(d.sweep),
      payoutFee: u(d.payoutFee),
      minAmount: u(d.min),
      depositFee: u(d.depositFee),
      hotMax: u(d.hotMax),
    };
  }

  async get(db: Queryable, asset: string): Promise<AssetSettings> {
    const { rows } = await db.query<Row>(
      'SELECT sweep_threshold, payout_fee, min_amount, deposit_fee, hot_max FROM asset_settings WHERE asset = $1',
      [asset],
    );
    const d = this.defaults(asset);
    const r = rows[0];
    if (!r) return d;
    const or = (v: string | null, fallback: bigint) => (v === null ? fallback : BigInt(v));
    return {
      asset,
      sweepThreshold: BigInt(r.sweep_threshold),
      payoutFee: BigInt(r.payout_fee),
      minAmount: or(r.min_amount, d.minAmount),
      depositFee: or(r.deposit_fee, d.depositFee),
      hotMax: or(r.hot_max, d.hotMax),
    };
  }

  async set(db: Queryable, asset: string, s: AssetSettingsInput): Promise<void> {
    await db.query(
      `INSERT INTO asset_settings (asset, sweep_threshold, payout_fee, min_amount, deposit_fee, hot_max)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (asset) DO UPDATE SET sweep_threshold = EXCLUDED.sweep_threshold, payout_fee = EXCLUDED.payout_fee,
         min_amount = EXCLUDED.min_amount, deposit_fee = EXCLUDED.deposit_fee, hot_max = EXCLUDED.hot_max,
         updated_at = now()`,
      [asset, s.sweepThreshold.toString(), s.payoutFee.toString(), s.minAmount.toString(), s.depositFee.toString(), s.hotMax.toString()],
    );
  }

  /** Human-readable values for the panels. */
  async view(db: Queryable, assets: string[]) {
    const out = [];
    for (const asset of assets) {
      const def = findAsset(this.registry, asset)!;
      const s = await this.get(db, asset);
      const f = (v: bigint) => fromBaseUnits(v, def.decimals);
      out.push({
        asset,
        sweep_threshold: f(s.sweepThreshold),
        payout_fee: f(s.payoutFee),
        min_amount: f(s.minAmount),
        deposit_fee: f(s.depositFee),
        hot_max: f(s.hotMax),
      });
    }
    return out;
  }
}

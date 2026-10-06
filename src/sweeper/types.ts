import type { AssetDef } from '../chains/assets.js';

export type SweepResult = 'empty' | 'waiting_gas' | 'swept';

export interface PreparedTx {
  /** Known before broadcast so it can be persisted first (no double payouts after a crash). */
  hash: string;
  broadcast(): Promise<void>;
}

export type TxState = 'pending' | 'success' | 'failed' | 'unknown';

export interface ChainSigner {
  readonly chain: string;
  readonly hotAddress: string;
  /** Moves the full `asset` balance of the deposit address at `index` to the hot wallet. */
  sweep(index: number, depositAddress: string, asset: AssetDef, record: (kind: 'gas_topup' | 'sweep', hash: string, amount: bigint) => Promise<void>): Promise<SweepResult>;
  preparePayout(asset: AssetDef, to: string, amount: bigint): Promise<PreparedTx>;
  txState(hash: string): Promise<TxState>;
  validateAddress(address: string): boolean;
}

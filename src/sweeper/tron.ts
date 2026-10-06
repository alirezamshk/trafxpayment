import { TronWeb } from 'tronweb';
import { config } from '../config.js';
import type { AssetDef } from '../chains/assets.js';
import { HOT_ACCOUNT, isValidTronAddress, type SigningWallet } from '../wallet/hd.js';
import type { ChainSigner, PreparedTx, SweepResult, TxState } from './types.js';

const SUN = 1_000_000n;
/** TRX left behind on native sweeps to pay bandwidth if the account has no free bandwidth left. */
const TRX_SWEEP_RESERVE = 1_100_000n;

// tronweb's generics are awkward; keep the surface we use narrow and explicit.
type AnyTx = { txID: string } & Record<string, unknown>;

export class TronSigner implements ChainSigner {
  readonly chain = 'tron';
  readonly hotAddress: string;
  private readonly tw: TronWeb;
  private readonly hotKey: string;

  constructor(private readonly keys: SigningWallet) {
    const headers: Record<string, string> = {};
    if (config.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = config.TRON_API_KEY;
    this.tw = new TronWeb({ fullHost: config.TRON_API_URL, headers });
    const hk = keys.privateKey('tron', 0, HOT_ACCOUNT);
    this.hotAddress = hk.address;
    this.hotKey = hk.privateKey.slice(2);
  }

  validateAddress(address: string): boolean {
    return isValidTronAddress(address);
  }

  private async prepare(unsigned: AnyTx, privateKey: string): Promise<PreparedTx> {
    const signed = (await this.tw.trx.sign(unsigned as never, privateKey)) as unknown as AnyTx;
    return {
      hash: signed.txID,
      broadcast: async () => {
        const r = (await this.tw.trx.sendRawTransaction(signed as never)) as unknown as { result?: boolean; code?: string; message?: string };
        if (!r.result) {
          const msg = r.message ? Buffer.from(r.message, 'hex').toString() : '';
          throw new Error(`TRON broadcast failed: ${r.code ?? ''} ${msg}`);
        }
      },
    };
  }

  private async sendTrx(from: string, key: string, to: string, sun: bigint): Promise<PreparedTx> {
    const tx = (await this.tw.transactionBuilder.sendTrx(to, Number(sun), from)) as unknown as AnyTx;
    return this.prepare(tx, key);
  }

  private async sendTrc20(from: string, key: string, contract: string, to: string, amount: bigint): Promise<PreparedTx> {
    const r = (await this.tw.transactionBuilder.triggerSmartContract(
      contract,
      'transfer(address,uint256)',
      { feeLimit: config.TRON_SWEEP_FEE_LIMIT_TRX * 1_000_000 },
      [
        { type: 'address', value: to },
        { type: 'uint256', value: amount.toString() },
      ],
      from,
    )) as unknown as { result?: { result?: boolean }; transaction: AnyTx };
    if (!r.result?.result) throw new Error('triggerSmartContract failed');
    return this.prepare(r.transaction, key);
  }

  private async trc20Balance(contract: string, owner: string): Promise<bigint> {
    const r = (await this.tw.transactionBuilder.triggerConstantContract(
      contract,
      'balanceOf(address)',
      {},
      [{ type: 'address', value: owner }],
      owner,
    )) as unknown as { constant_result?: string[] };
    const hex = r.constant_result?.[0];
    return hex ? BigInt('0x' + (hex || '0')) : 0n;
  }

  async sweep(index: number, depositAddress: string, asset: AssetDef, record: (kind: 'gas_topup' | 'sweep', hash: string, amount: bigint) => Promise<void>): Promise<SweepResult> {
    const k = this.keys.privateKey('tron', index);
    if (k.address !== depositAddress) throw new Error(`Key mismatch for index ${index}`);
    const key = k.privateKey.slice(2);
    const trx = BigInt(await this.tw.trx.getBalance(depositAddress));

    if (!asset.contract) {
      if (trx <= TRX_SWEEP_RESERVE * 2n) return 'empty';
      const amount = trx - TRX_SWEEP_RESERVE;
      const tx = await this.sendTrx(depositAddress, key, this.hotAddress, amount);
      await record('sweep', tx.hash, amount);
      await tx.broadcast();
      return 'swept';
    }

    const balance = await this.trc20Balance(asset.contract, depositAddress);
    if (balance === 0n) return 'empty';
    // Without staked energy a USDT transfer burns TRX; top the address up from the hot wallet first.
    // (For high volume, delegate energy from the hot wallet instead — far cheaper than burning.)
    const needed = BigInt(config.TRON_SWEEP_TRX_TOPUP) * SUN;
    if (trx < needed) {
      const topUp = needed - trx;
      const tx = await this.sendTrx(this.hotAddress, this.hotKey, depositAddress, topUp);
      await record('gas_topup', tx.hash, topUp);
      await tx.broadcast();
      return 'waiting_gas';
    }
    const tx = await this.sendTrc20(depositAddress, key, asset.contract, this.hotAddress, balance);
    await record('sweep', tx.hash, balance);
    await tx.broadcast();
    return 'swept';
  }

  async preparePayout(asset: AssetDef, to: string, amount: bigint): Promise<PreparedTx> {
    return asset.contract
      ? this.sendTrc20(this.hotAddress, this.hotKey, asset.contract, to, amount)
      : this.sendTrx(this.hotAddress, this.hotKey, to, amount);
  }

  async txState(hash: string): Promise<TxState> {
    const info = (await this.tw.trx.getTransactionInfo(hash).catch(() => ({}))) as {
      id?: string;
      blockNumber?: number;
      result?: string;
      receipt?: { result?: string };
    };
    if (info?.id && info.blockNumber) {
      const failed = info.result === 'FAILED' || (info.receipt?.result && info.receipt.result !== 'SUCCESS');
      return failed ? 'failed' : 'success';
    }
    const tx = await this.tw.trx.getTransaction(hash).catch(() => null);
    return tx ? 'pending' : 'unknown';
  }
}

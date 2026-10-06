import { Contract, Interface, isAddress, JsonRpcProvider, Transaction, Wallet } from 'ethers';
import type { AssetDef, ChainDef } from '../chains/assets.js';
import { HOT_ACCOUNT, type SigningWallet } from '../wallet/hd.js';
import type { ChainSigner, PreparedTx, SweepResult, TxState } from './types.js';

const ERC20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount)',
]);
const TOKEN_GAS_LIMIT = 100_000n;
const NATIVE_GAS_LIMIT = 21_000n;

export class EvmSigner implements ChainSigner {
  readonly chain: string;
  readonly hotAddress: string;
  private readonly provider: JsonRpcProvider;
  private readonly hot: Wallet;

  constructor(
    def: ChainDef,
    private readonly keys: SigningWallet,
  ) {
    this.chain = def.id;
    this.provider = new JsonRpcProvider(def.rpcUrl, undefined, { staticNetwork: true });
    const hk = keys.privateKey('evm', 0, HOT_ACCOUNT);
    this.hot = new Wallet(hk.privateKey, this.provider);
    this.hotAddress = hk.address;
  }

  validateAddress(address: string): boolean {
    return isAddress(address) && address.startsWith('0x');
  }

  /** Legacy gas price (+20%) so native sweeps can send `balance - fee` exactly on every EVM chain. */
  private async gasPrice(): Promise<bigint> {
    const fee = await this.provider.getFeeData();
    const p = fee.gasPrice ?? fee.maxFeePerGas;
    if (!p) throw new Error('No gas price from RPC');
    return (p * 12n) / 10n;
  }

  private async prepare(wallet: Wallet, tx: { to: string; value?: bigint; data?: string; gasLimit: bigint; gasPrice: bigint }): Promise<PreparedTx> {
    const network = await this.provider.getNetwork();
    const nonce = await this.provider.getTransactionCount(wallet.address, 'pending');
    const raw = await wallet.signTransaction({ ...tx, type: 0, nonce, chainId: network.chainId });
    return {
      hash: Transaction.from(raw).hash!,
      broadcast: async () => {
        await this.provider.broadcastTransaction(raw);
      },
    };
  }

  async sweep(index: number, depositAddress: string, asset: AssetDef, record: (kind: 'gas_topup' | 'sweep', hash: string, amount: bigint) => Promise<void>): Promise<SweepResult> {
    const k = this.keys.privateKey('evm', index);
    if (k.address.toLowerCase() !== depositAddress.toLowerCase()) throw new Error(`Key mismatch for index ${index}`);
    const wallet = new Wallet(k.privateKey, this.provider);
    const gasPrice = await this.gasPrice();
    const native = await this.provider.getBalance(depositAddress);

    if (!asset.contract) {
      const fee = NATIVE_GAS_LIMIT * gasPrice;
      if (native <= fee * 2n) return 'empty'; // dust not worth sweeping
      const amount = native - fee;
      const tx = await this.prepare(wallet, { to: this.hotAddress, value: amount, gasLimit: NATIVE_GAS_LIMIT, gasPrice });
      await record('sweep', tx.hash, amount);
      await tx.broadcast();
      return 'swept';
    }

    const token = new Contract(asset.contract, ERC20, this.provider);
    const balance = (await token.getFunction('balanceOf')(depositAddress)) as bigint;
    if (balance === 0n) return 'empty';

    const needed = TOKEN_GAS_LIMIT * gasPrice;
    if (native < needed) {
      const topUp = needed - native;
      const tx = await this.prepare(this.hot, { to: depositAddress, value: topUp, gasLimit: NATIVE_GAS_LIMIT, gasPrice });
      await record('gas_topup', tx.hash, topUp);
      await tx.broadcast();
      return 'waiting_gas';
    }
    const data = ERC20.encodeFunctionData('transfer', [this.hotAddress, balance]);
    const tx = await this.prepare(wallet, { to: asset.contract, data, gasLimit: TOKEN_GAS_LIMIT, gasPrice });
    await record('sweep', tx.hash, balance);
    await tx.broadcast();
    return 'swept';
  }

  async preparePayout(asset: AssetDef, to: string, amount: bigint): Promise<PreparedTx> {
    const gasPrice = await this.gasPrice();
    if (!asset.contract) {
      return this.prepare(this.hot, { to, value: amount, gasLimit: NATIVE_GAS_LIMIT, gasPrice });
    }
    const data = ERC20.encodeFunctionData('transfer', [to, amount]);
    return this.prepare(this.hot, { to: asset.contract, data, gasLimit: TOKEN_GAS_LIMIT, gasPrice });
  }

  async txState(hash: string): Promise<TxState> {
    const r = await this.provider.getTransactionReceipt(hash);
    if (r) return r.status === 1 ? 'success' : 'failed';
    const tx = await this.provider.getTransaction(hash);
    return tx ? 'pending' : 'unknown';
  }
}

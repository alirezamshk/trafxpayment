import { keyPairFromSeed, type KeyPair } from '@ton/crypto';
import { Address, beginCell, internal, SendMode, toNano, TonClient, WalletContractV4 } from '@ton/ton';
import { config } from '../config.js';
import type { AssetDef } from '../chains/assets.js';
import { tonHotSeed } from '../wallet/hd.js';
import { toncenterApi } from '../watchers/ton.js';
import type { ChainSigner, PreparedTx, SweepResult, TxState } from './types.js';

const OP_JETTON_TRANSFER = 0xf8a7ea5;

/**
 * TON payouts come straight from the treasury wallet (deposits already land there via memo, so no sweeping).
 * Wallet v4 has no hash known before broadcast, so the payout is identified by the wallet seqno it used:
 * once the on-chain seqno moves past it, the external message was accepted. Payouts are sent one at a time.
 */
export class TonSigner implements ChainSigner {
  readonly chain = 'ton';
  readonly serial = true;
  readonly hotAddress: string;
  private readonly key: KeyPair;
  private readonly wallet: WalletContractV4;
  private readonly client: TonClient;
  private jettonWallets = new Map<string, Address>();

  constructor(mnemonic: string) {
    this.key = keyPairFromSeed(tonHotSeed(mnemonic));
    this.wallet = WalletContractV4.create({ workchain: 0, publicKey: this.key.publicKey });
    this.hotAddress = this.wallet.address.toString({ bounceable: false });
    this.client = new TonClient({ endpoint: config.TON_V2_RPC_URL, apiKey: config.TON_API_KEY });
  }

  validateAddress(address: string): boolean {
    try {
      Address.parse(address);
      return true;
    } catch {
      return false;
    }
  }

  async sweep(): Promise<SweepResult> {
    return 'empty';
  }

  private async jettonWallet(master: string): Promise<Address> {
    let w = this.jettonWallets.get(master);
    if (!w) {
      w = Address.parse(await toncenterApi().jettonWalletAddress(master, this.wallet.address.toString()));
      this.jettonWallets.set(master, w);
    }
    return w;
  }

  async preparePayout(asset: AssetDef, to: string, amount: bigint): Promise<PreparedTx> {
    const contract = this.client.open(this.wallet);
    const seqno = await contract.getSeqno();
    const dest = Address.parse(to);
    const message = asset.contract
      ? internal({
          to: await this.jettonWallet(asset.contract),
          value: toNano('0.05'),
          bounce: true,
          body: beginCell()
            .storeUint(OP_JETTON_TRANSFER, 32)
            .storeUint(BigInt(Date.now()), 64)
            .storeCoins(amount)
            .storeAddress(dest)
            .storeAddress(this.wallet.address) // excess TON comes back to us
            .storeBit(0)
            .storeCoins(1n)
            .storeBit(0)
            .endCell(),
        })
      : internal({ to: dest, value: amount, bounce: false, body: 'payout' });

    return {
      hash: `ton-seqno:${this.wallet.address.toRawString()}:${seqno}`,
      broadcast: async () => {
        await contract.sendTransfer({
          seqno,
          secretKey: this.key.secretKey,
          sendMode: SendMode.PAY_GAS_SEPARATELY,
          messages: [message],
        });
      },
    };
  }

  async txState(hash: string): Promise<TxState> {
    const m = /^ton-seqno:.*:(\d+)$/.exec(hash);
    if (!m) return 'unknown';
    const seqno = await this.client.open(this.wallet).getSeqno();
    return seqno > Number(m[1]) ? 'success' : 'pending';
  }
}

import { getAddress, id as keccakId, JsonRpcProvider, zeroPadValue, type Log } from 'ethers';
import { config } from '../config.js';
import { getCursor, pool, setCursor } from '../db.js';
import type { AssetDef, ChainDef } from '../chains/assets.js';
import type { InvoiceRow, InvoiceService } from '../services/invoices.js';
import type { Logger, Watcher } from './types.js';

export const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');

/** Minimal RPC surface used by the watcher, so tests can stub it. */
export interface EvmRpc {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { fromBlock: number; toBlock: number; address: string[]; topics: (string | string[] | null)[] }): Promise<Log[]>;
  getBlockTransactions(blockNumber: number): Promise<{ hash: string; from: string; to: string | null; value: bigint }[]>;
  getReceipt(txHash: string): Promise<{ status: number | null; blockNumber: number; blockHash: string } | null>;
}

export function ethersRpc(url: string): EvmRpc {
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 20 });
  return {
    getBlockNumber: () => provider.getBlockNumber(),
    getLogs: (f) => provider.getLogs(f),
    async getBlockTransactions(n) {
      const block = await provider.getBlock(n, true);
      if (!block) throw new Error(`Block ${n} not available yet`);
      return block.prefetchedTransactions.map((t) => ({ hash: t.hash, from: t.from, to: t.to, value: t.value }));
    },
    async getReceipt(hash) {
      const r = await provider.getTransactionReceipt(hash);
      return r ? { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash } : null;
    },
  };
}

export interface DetectedTransfer {
  asset: AssetDef;
  txHash: string;
  eventIndex: string;
  from: string;
  to: string;
  amount: bigint;
  blockNumber: number;
  blockHash: string | null;
}

/**
 * Decodes ERC20 Transfer logs addressed to watched addresses.
 * eventIndex is "<token>:<to>:<n>" where n counts matching transfers inside the tx; unlike the raw
 * log index it stays the same if the tx is re-mined in a different block after a reorg.
 */
export function decodeTokenLogs(logs: Log[], tokens: AssetDef[], watched: Set<string>): DetectedTransfer[] {
  const byContract = new Map(tokens.map((t) => [t.contract!.toLowerCase(), t]));
  const ordinals = new Map<string, number>();
  const out: DetectedTransfer[] = [];
  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of sorted) {
    if (log.removed) continue;
    const asset = byContract.get(log.address.toLowerCase());
    if (!asset || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const to = getAddress('0x' + log.topics[2]!.slice(26));
    if (!watched.has(to.toLowerCase())) continue;
    const amount = BigInt(log.data);
    if (amount === 0n) continue;
    const key = `${log.transactionHash}:${asset.contract!.toLowerCase()}:${to.toLowerCase()}`;
    const n = ordinals.get(key) ?? 0;
    ordinals.set(key, n + 1);
    out.push({
      asset,
      txHash: log.transactionHash,
      eventIndex: `${asset.contract!.toLowerCase()}:${to.toLowerCase()}:${n}`,
      from: getAddress('0x' + log.topics[1]!.slice(26)),
      to,
      amount,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
    });
  }
  return out;
}

export class EvmWatcher implements Watcher {
  readonly name: string;
  readonly intervalMs = config.EVM_POLL_INTERVAL_MS;
  private readonly cursorKey: string;
  private readonly reorgOverlap: number;

  constructor(
    private readonly chain: ChainDef,
    private readonly assets: AssetDef[],
    private readonly invoices: InvoiceService,
    private readonly rpc: EvmRpc,
    private readonly log: Logger,
    private readonly maxBlocksPerTick = config.EVM_MAX_BLOCKS_PER_TICK,
  ) {
    this.name = `evm:${chain.id}`;
    this.cursorKey = `evm:${chain.id}:last_block`;
    this.reorgOverlap = Math.min(chain.confirmations, 6);
  }

  async tick(): Promise<void> {
    const latest = await this.rpc.getBlockNumber();
    await this.scan(latest);
    await this.updateConfirmations(latest);
  }

  private async scan(latest: number): Promise<void> {
    const stored = await getCursor(pool, this.cursorKey);
    const last = stored !== undefined ? Number(stored) : latest - config.EVM_START_BLOCK_LOOKBACK - 1;
    if (last >= latest) return;

    const from = Math.max(0, last + 1 - (stored !== undefined ? this.reorgOverlap : 0));
    const to = Math.min(latest, last + this.maxBlocksPerTick);

    const watched = await this.invoices.watched(pool, this.chain.id);
    if (watched.length === 0) {
      await setCursor(pool, this.cursorKey, String(to));
      return;
    }

    const byAddress = new Map<string, InvoiceRow>();
    for (const inv of watched) byAddress.set(inv.address!.toLowerCase(), inv);

    const tokens = this.assets.filter((a) => a.contract);
    const native = this.assets.find((a) => !a.contract);
    const transfers: DetectedTransfer[] = [];

    // ERC20 / BEP20: filter by `to` topic, 100 addresses per request.
    const addrs = [...byAddress.keys()];
    if (tokens.length) {
      for (let i = 0; i < addrs.length; i += 100) {
        const chunk = addrs.slice(i, i + 100).map((a) => zeroPadValue(a, 32));
        const logs = await this.rpc.getLogs({
          fromBlock: from,
          toBlock: to,
          address: tokens.map((t) => t.contract!),
          topics: [TRANSFER_TOPIC, null, chunk],
        });
        transfers.push(...decodeTokenLogs(logs, tokens, new Set(addrs)));
      }
    }

    // Native coin: only scan full blocks if some watched invoice actually expects it.
    if (native && watched.some((w) => w.asset === native.id)) {
      for (let n = from; n <= to; n++) {
        const txs = await this.rpc.getBlockTransactions(n);
        for (const tx of txs) {
          if (!tx.to || tx.value === 0n || !byAddress.has(tx.to.toLowerCase())) continue;
          transfers.push({
            asset: native,
            txHash: tx.hash,
            eventIndex: `native:${tx.to.toLowerCase()}`,
            from: tx.from,
            to: getAddress(tx.to),
            amount: tx.value,
            blockNumber: n,
            blockHash: null,
          });
        }
      }
    }

    for (const t of transfers) {
      const inv = byAddress.get(t.to.toLowerCase());
      // A transfer of the wrong asset to an invoice address is kept, but not credited (manual review).
      const invoiceId = inv && inv.asset === t.asset.id ? inv.id : null;
      const isNew = await this.invoices.recordDeposit({
        invoiceId,
        chain: this.chain.id,
        asset: t.asset.id,
        txHash: t.txHash,
        eventIndex: t.eventIndex,
        from: t.from,
        to: t.to,
        amount: t.amount,
        blockNumber: t.blockNumber,
        blockHash: t.blockHash,
        confirmations: latest - t.blockNumber + 1,
      });
      if (isNew) {
        this.log.info(
          { chain: this.chain.id, asset: t.asset.id, tx: t.txHash, amount: t.amount.toString(), invoice: invoiceId },
          invoiceId ? 'deposit detected' : 'unmatched deposit (wrong asset) detected',
        );
      }
    }
    await setCursor(pool, this.cursorKey, String(to));
  }

  /** Re-checks receipts of pending deposits; confirms them or marks them orphaned after a reorg. */
  private async updateConfirmations(latest: number): Promise<void> {
    const { rows } = await pool.query<{ id: string; tx_hash: string; block_number: string; block_hash: string | null; detected_at: Date }>(
      `SELECT id, tx_hash, block_number, block_hash, detected_at FROM deposits WHERE chain = $1 AND status = 'pending'`,
      [this.chain.id],
    );
    for (const d of rows) {
      const confs = latest - Number(d.block_number) + 1;
      if (confs < this.chain.confirmations) {
        await pool.query('UPDATE deposits SET confirmations = $2 WHERE id = $1', [d.id, Math.max(confs, 0)]);
        continue;
      }
      const receipt = await this.rpc.getReceipt(d.tx_hash);
      if (!receipt) {
        // Dropped by a reorg. Give the node some time before giving up.
        if (Date.now() - d.detected_at.getTime() > 30 * 60_000) {
          await this.invoices.updateDepositConfirmations(d.id, 0, 'orphaned');
          this.log.warn({ chain: this.chain.id, tx: d.tx_hash }, 'deposit orphaned');
        }
        continue;
      }
      if (receipt.status !== 1) {
        await this.invoices.updateDepositConfirmations(d.id, 0, 'orphaned');
        this.log.warn({ chain: this.chain.id, tx: d.tx_hash }, 'deposit tx reverted');
        continue;
      }
      const realConfs = latest - receipt.blockNumber + 1;
      if (receipt.blockNumber !== Number(d.block_number) || (d.block_hash && d.block_hash !== receipt.blockHash)) {
        // Re-mined in another block: track the new position and wait again.
        await pool.query('UPDATE deposits SET block_number = $2, block_hash = $3, confirmations = $4 WHERE id = $1', [
          d.id,
          receipt.blockNumber,
          receipt.blockHash,
          Math.max(realConfs, 0),
        ]);
        if (realConfs < this.chain.confirmations) continue;
      }
      await this.invoices.updateDepositConfirmations(d.id, realConfs, 'confirmed');
      this.log.info({ chain: this.chain.id, tx: d.tx_hash, confirmations: realConfs }, 'deposit confirmed');
    }
  }
}

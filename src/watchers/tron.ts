import { config } from '../config.js';
import { pool } from '../db.js';
import type { AssetDef, ChainDef } from '../chains/assets.js';
import type { InvoiceService } from '../services/invoices.js';
import { tronHexToBase58, tronToHex } from '../wallet/hd.js';
import { fetchJson, type Logger, type Watcher } from './types.js';

export interface TronTrc20Transfer {
  transaction_id: string;
  token_info: { address: string; decimals: number; symbol?: string };
  block_timestamp: number;
  from: string;
  to: string;
  type: string;
  value: string;
}

export interface TronTx {
  txID: string;
  blockNumber?: number;
  block_timestamp?: number;
  ret?: { contractRet?: string }[];
  raw_data?: {
    contract?: { type: string; parameter: { value: { amount?: number; owner_address?: string; to_address?: string } } }[];
  };
}

export interface TronTxInfo {
  id?: string;
  blockNumber?: number;
  result?: string; // "FAILED" on failure, absent on success
  receipt?: { result?: string };
}

export interface TronApi {
  trc20Transfers(address: string, contract: string, minTimestamp: number): Promise<TronTrc20Transfer[]>;
  transactions(address: string, minTimestamp: number): Promise<TronTx[]>;
  /** Solidified (irreversible) transaction info, or null if not yet solidified. */
  solidTxInfo(txId: string): Promise<TronTxInfo | null>;
  txInfo(txId: string): Promise<TronTxInfo | null>;
  latestBlock(): Promise<number>;
}

export function tronGridApi(baseUrl = config.TRON_API_URL, apiKey = config.TRON_API_KEY): TronApi {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;
  const get = <T>(path: string) => fetchJson<T>(`${baseUrl}${path}`, { headers });
  const post = <T>(path: string, body: unknown) =>
    fetchJson<T>(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const nonEmpty = (info: TronTxInfo) => (info && info.id ? info : null);

  return {
    async trc20Transfers(address, contract, minTimestamp) {
      const r = await get<{ data: TronTrc20Transfer[] }>(
        `/v1/accounts/${address}/transactions/trc20?only_to=true&limit=200&contract_address=${contract}&min_timestamp=${minTimestamp}`,
      );
      return r.data ?? [];
    },
    async transactions(address, minTimestamp) {
      const r = await get<{ data: TronTx[] }>(
        `/v1/accounts/${address}/transactions?only_to=true&limit=200&min_timestamp=${minTimestamp}`,
      );
      return r.data ?? [];
    },
    async solidTxInfo(txId) {
      return nonEmpty(await post<TronTxInfo>('/walletsolidity/gettransactioninfobyid', { value: txId }));
    },
    async txInfo(txId) {
      return nonEmpty(await post<TronTxInfo>('/wallet/gettransactioninfobyid', { value: txId }));
    },
    async latestBlock() {
      const r = await post<{ block_header: { raw_data: { number: number } } }>('/wallet/getnowblock', {});
      return r.block_header.raw_data.number;
    },
  };
}

export interface TronDetected {
  asset: AssetDef;
  txHash: string;
  eventIndex: string;
  from: string;
  to: string;
  amount: bigint;
  blockNumber: number | null;
}

/** USDT-TRC20 transfers to `address`, rejecting any token whose contract is not the configured one (fake USDT). */
export function parseTrc20(items: TronTrc20Transfer[], address: string, asset: AssetDef): TronDetected[] {
  const ordinals = new Map<string, number>();
  const out: TronDetected[] = [];
  for (const t of items) {
    if (t.to !== address || t.type !== 'Transfer') continue;
    if (t.token_info?.address !== asset.contract) continue;
    const amount = BigInt(t.value);
    if (amount === 0n) continue;
    const n = ordinals.get(t.transaction_id) ?? 0;
    ordinals.set(t.transaction_id, n + 1);
    out.push({ asset, txHash: t.transaction_id, eventIndex: `trc20:${n}`, from: t.from, to: t.to, amount, blockNumber: null });
  }
  return out;
}

/** Native TRX transfers (TransferContract only; TRC10 "TransferAssetContract" airdrops are ignored). */
export function parseTrx(items: TronTx[], address: string, asset: AssetDef): TronDetected[] {
  const hex = tronToHex(address).toLowerCase();
  const out: TronDetected[] = [];
  for (const tx of items) {
    if (!tx.txID || !tx.raw_data?.contract) continue;
    if (tx.ret?.[0]?.contractRet && tx.ret[0].contractRet !== 'SUCCESS') continue;
    const c = tx.raw_data.contract[0];
    if (!c || c.type !== 'TransferContract') continue;
    const v = c.parameter.value;
    if (v.to_address?.toLowerCase() !== hex || !v.amount) continue;
    out.push({
      asset,
      txHash: tx.txID,
      eventIndex: 'trx',
      from: v.owner_address ? tronHexToBase58(v.owner_address) : '',
      to: address,
      amount: BigInt(v.amount),
      blockNumber: tx.blockNumber ?? null,
    });
  }
  return out;
}

const IDLE_POLL_MS = 5 * 60_000;

export class TronWatcher implements Watcher {
  readonly name = 'tron';
  readonly intervalMs = config.TRON_POLL_INTERVAL_MS;
  private readonly lastPolled = new Map<string, number>();

  constructor(
    private readonly chain: ChainDef,
    private readonly assets: AssetDef[],
    private readonly invoices: InvoiceService,
    private readonly api: TronApi,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<void> {
    await this.scan();
    await this.updateConfirmations();
  }

  private async scan(): Promise<void> {
    const watched = await this.invoices.watched(pool, this.chain.id);
    const usdt = this.assets.find((a) => a.contract);
    const trx = this.assets.find((a) => !a.contract);

    const now = Date.now();
    for (const inv of watched) {
      const address = inv.address!;
      // Addresses with an open invoice are polled every tick; idle ones (late / repeat payments on
      // permanent customer addresses) every few minutes, to stay inside TronGrid rate limits.
      const open = ['pending', 'confirming', 'partially_paid'].includes(inv.status) && inv.expires_at.getTime() > now;
      if (!open && now - (this.lastPolled.get(address) ?? 0) < IDLE_POLL_MS) continue;
      this.lastPolled.set(address, now);
      const since = inv.created_at.getTime() - 60_000;
      const found: TronDetected[] = [];
      try {
        // Query both assets so a payment in the wrong currency is still recorded for review.
        if (usdt) found.push(...parseTrc20(await this.api.trc20Transfers(address, usdt.contract!, since), address, usdt));
        if (trx) found.push(...parseTrx(await this.api.transactions(address, since), address, trx));
      } catch (err) {
        this.log.warn({ address, err: (err as Error).message }, 'tron poll failed');
        continue;
      }
      for (const d of found) {
        const isNew = await this.invoices.recordDeposit({
          invoiceId: inv.asset === d.asset.id ? inv.id : null,
          chain: this.chain.id,
          asset: d.asset.id,
          txHash: d.txHash,
          eventIndex: d.eventIndex,
          from: d.from,
          to: d.to,
          amount: d.amount,
          blockNumber: d.blockNumber,
        });
        if (isNew) this.log.info({ chain: 'tron', asset: d.asset.id, tx: d.txHash, invoice: inv.id }, 'deposit detected');
      }
    }
  }

  private async updateConfirmations(): Promise<void> {
    const { rows } = await pool.query<{ id: string; tx_hash: string; block_number: string | null; detected_at: Date }>(
      `SELECT id, tx_hash, block_number, detected_at FROM deposits WHERE chain = $1 AND status = 'pending'`,
      [this.chain.id],
    );
    if (rows.length === 0) return;
    const latest = await this.api.latestBlock();

    for (const d of rows) {
      const solid = await this.api.solidTxInfo(d.tx_hash);
      if (solid?.blockNumber) {
        const failed = solid.result === 'FAILED' || (solid.receipt?.result && solid.receipt.result !== 'SUCCESS');
        await this.invoices.updateDepositConfirmations(
          d.id,
          failed ? 0 : latest - solid.blockNumber + 1,
          failed ? 'orphaned' : 'confirmed',
        );
        this.log.info({ chain: 'tron', tx: d.tx_hash, failed }, failed ? 'deposit failed on chain' : 'deposit confirmed');
        continue;
      }
      const info = await this.api.txInfo(d.tx_hash);
      if (info?.blockNumber) {
        await pool.query('UPDATE deposits SET block_number = $2, confirmations = $3 WHERE id = $1', [
          d.id,
          info.blockNumber,
          Math.max(0, latest - info.blockNumber + 1),
        ]);
      } else if (Date.now() - d.detected_at.getTime() > 30 * 60_000) {
        await this.invoices.updateDepositConfirmations(d.id, 0, 'orphaned');
        this.log.warn({ chain: 'tron', tx: d.tx_hash }, 'deposit never included; orphaned');
      }
    }
  }
}

import { Address, beginCell, Cell, type Slice } from '@ton/core';
import { config } from '../config.js';
import { getCursor, pool, setCursor } from '../db.js';
import type { AssetDef, ChainDef } from '../chains/assets.js';
import type { InvoiceService } from '../services/invoices.js';
import { fetchJson, type Logger, type Watcher } from './types.js';

export const OP_INTERNAL_TRANSFER = 0x178d4519;
const DUST_NANOTON = 10_000_000n; // 0.01 TON — ignore smaller unmatched spam

export interface TonMessage {
  hash?: string;
  source: string | null;
  destination: string | null;
  value: string | null;
  bounced?: boolean | null;
  message_content?: { body?: string | null; decoded?: { type?: string; comment?: string } | null } | null;
}

export interface TonTransaction {
  account: string;
  hash: string;
  lt: string;
  now: number;
  description?: { aborted?: boolean; compute_ph?: { success?: boolean; skipped?: boolean } };
  in_msg?: TonMessage | null;
}

export interface TonApi {
  transactions(account: string, startLt: string | undefined, startUtime: number | undefined, limit: number): Promise<TonTransaction[]>;
  jettonWalletAddress(master: string, owner: string): Promise<string>;
}

export function toncenterApi(baseUrl = config.TON_API_URL, apiKey = config.TON_API_KEY): TonApi {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  return {
    async transactions(account, startLt, startUtime, limit) {
      const u = new URL(`${baseUrl}/transactions`);
      u.searchParams.set('account', account);
      u.searchParams.set('limit', String(limit));
      u.searchParams.set('sort', 'asc');
      if (startLt) u.searchParams.set('start_lt', startLt);
      else if (startUtime) u.searchParams.set('start_utime', String(startUtime));
      const r = await fetchJson<{ transactions: TonTransaction[] }>(u.toString(), { headers });
      return r.transactions ?? [];
    },
    async jettonWalletAddress(master, owner) {
      const ownerCell = beginCell().storeAddress(Address.parse(owner)).endCell().toBoc().toString('base64');
      const r = await fetchJson<{ exit_code: number; stack: { type: string; value: string }[] }>(`${baseUrl}/runGetMethod`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ address: master, method: 'get_wallet_address', stack: [{ type: 'slice', value: ownerCell }] }),
      });
      const item = r.stack?.[0];
      if (r.exit_code !== 0 || !item) throw new Error(`get_wallet_address failed (exit ${r.exit_code})`);
      return Cell.fromBase64(item.value).beginParse().loadAddress().toRawString();
    },
  };
}

/** Reads a "text comment" payload: 32-bit zero opcode followed by UTF-8 text (snake-encoded). */
export function readComment(slice: Slice): string | null {
  if (slice.remainingBits < 32) return null;
  if (slice.loadUint(32) !== 0) return null;
  return slice.loadStringTail();
}

export function commentFromBody(bodyB64: string | null | undefined): string | null {
  if (!bodyB64) return null;
  try {
    return readComment(Cell.fromBase64(bodyB64).beginParse());
  } catch {
    return null;
  }
}

export interface JettonInternalTransfer {
  amount: bigint;
  from: string | null;
  comment: string | null;
}

/**
 * Parses the internal_transfer message our USDT jetton wallet receives:
 * op:uint32 query_id:uint64 amount:Coins from:MsgAddress response:MsgAddress fwd_ton:Coins fwd_payload:(Either Cell ^Cell)
 * The jetton wallet contract itself verifies the sender is a genuine wallet of the same master, so a
 * successful (non-aborted) transaction here cannot be a fake token.
 */
export function parseInternalTransfer(bodyB64: string): JettonInternalTransfer | null {
  try {
    const s = Cell.fromBase64(bodyB64).beginParse();
    if (s.loadUint(32) !== OP_INTERNAL_TRANSFER) return null;
    s.loadUintBig(64);
    const amount = s.loadCoins();
    const from = s.loadMaybeAddress();
    s.loadMaybeAddress();
    s.loadCoins();
    let comment: string | null = null;
    if (s.remainingBits > 0) {
      const payload = s.loadBit() ? s.loadRef().beginParse() : s;
      try {
        comment = readComment(payload);
      } catch {
        comment = null;
      }
    }
    return { amount, from: from ? from.toString({ bounceable: false }) : null, comment };
  } catch {
    return null;
  }
}

export function normalizeMemo(c: string | null): string | null {
  if (!c) return null;
  const m = c.trim().toUpperCase();
  return m.length > 0 && m.length <= 64 ? m : null;
}

function succeeded(tx: TonTransaction): boolean {
  return !tx.description?.aborted && tx.description?.compute_ph?.success !== false;
}

export function txHashHex(hash: string): string {
  return /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : Buffer.from(hash, 'base64').toString('hex');
}

export class TonWatcher implements Watcher {
  readonly name = 'ton';
  readonly intervalMs = config.TON_POLL_INTERVAL_MS;
  private jettonWallet?: string;

  constructor(
    private readonly chain: ChainDef,
    private readonly assets: AssetDef[],
    private readonly invoices: InvoiceService,
    private readonly api: TonApi,
    private readonly treasury: string,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<void> {
    const ton = this.assets.find((a) => !a.contract);
    const usdt = this.assets.find((a) => a.contract);
    if (ton) await this.scanAccount(Address.parse(this.treasury).toRawString(), 'ton:treasury', (tx) => this.handleNative(tx, ton));
    if (usdt) {
      if (!this.jettonWallet) {
        this.jettonWallet = await this.api.jettonWalletAddress(usdt.contract!, this.treasury);
        this.log.info({ jettonWallet: this.jettonWallet }, 'resolved treasury USDT jetton wallet');
      }
      await this.scanAccount(this.jettonWallet, 'ton:jetton:usdt', (tx) => this.handleJetton(tx, usdt));
    }
  }

  private async scanAccount(account: string, cursorKey: string, handle: (tx: TonTransaction) => Promise<void>) {
    let cursor = await getCursor(pool, cursorKey);
    const startUtime = cursor ? undefined : Math.floor(Date.now() / 1000) - 3600;
    for (let page = 0; page < 10; page++) {
      const startLt = cursor ? (BigInt(cursor) + 1n).toString() : undefined;
      const txs = await this.api.transactions(account, startLt, startUtime, 100);
      for (const tx of txs) {
        await handle(tx);
        cursor = tx.lt;
        await setCursor(pool, cursorKey, cursor);
      }
      if (txs.length < 100) break;
    }
  }

  private async findInvoice(memo: string | null) {
    if (!memo) return undefined;
    const { rows } = await pool.query<{ id: string; asset: string }>(
      `SELECT id, asset FROM invoices WHERE chain = 'ton' AND memo = $1`,
      [memo],
    );
    return rows[0];
  }

  private async handleNative(tx: TonTransaction, asset: AssetDef) {
    const msg = tx.in_msg;
    if (!msg?.source || !msg.value || msg.bounced || !succeeded(tx)) return;
    const amount = BigInt(msg.value);
    const comment = msg.message_content?.decoded?.comment ?? commentFromBody(msg.message_content?.body);
    const memo = normalizeMemo(comment);
    const inv = await this.findInvoice(memo);
    if (!inv && amount < DUST_NANOTON) return;
    await this.save(tx, asset, amount, msg.source, memo, inv && inv.asset === asset.id ? inv.id : null);
  }

  private async handleJetton(tx: TonTransaction, asset: AssetDef) {
    const body = tx.in_msg?.message_content?.body;
    if (!body || !succeeded(tx)) return;
    const t = parseInternalTransfer(body);
    if (!t || t.amount === 0n) return;
    const memo = normalizeMemo(t.comment);
    const inv = await this.findInvoice(memo);
    await this.save(tx, asset, t.amount, t.from, memo, inv && inv.asset === asset.id ? inv.id : null);
  }

  private async save(tx: TonTransaction, asset: AssetDef, amount: bigint, from: string | null, memo: string | null, invoiceId: string | null) {
    const isNew = await this.invoices.recordDeposit({
      invoiceId,
      chain: this.chain.id,
      asset: asset.id,
      txHash: txHashHex(tx.hash),
      eventIndex: '0',
      from,
      to: this.treasury,
      memo,
      amount,
      blockNumber: BigInt(tx.lt),
      confirmations: 1,
      confirmed: true, // toncenter v3 only indexes finalized blocks
    });
    if (isNew) {
      this.log.info(
        { chain: 'ton', asset: asset.id, tx: tx.hash, memo, invoice: invoiceId },
        invoiceId ? 'deposit detected' : 'unmatched TON deposit',
      );
    }
  }
}

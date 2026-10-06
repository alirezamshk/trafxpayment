import { beginCell, Address } from '@ton/core';
import { id, zeroPadValue, type Log } from 'ethers';
import { describe, expect, it } from 'vitest';
import { applyTolerance, fromBaseUnits, quoteAmount, toBaseUnits } from '../src/lib/amount.js';
import { computeStatus } from '../src/services/status.js';
import { computeFee, isSettlementDue, lastScheduledSettlement } from '../src/services/ledger.js';
import { signPayload, verifySignature } from '../src/services/webhooks.js';
import { SigningWallet, slip10Ed25519, tronToHex, WatchOnlyWallet } from '../src/wallet/hd.js';
import { decodeTokenLogs, TRANSFER_TOPIC } from '../src/watchers/evm.js';
import { commentFromBody, OP_INTERNAL_TRANSFER, parseInternalTransfer } from '../src/watchers/ton.js';
import { parseTrc20, parseTrx } from '../src/watchers/tron.js';
import type { AssetDef } from '../src/chains/assets.js';
import { TEST_MNEMONIC } from './setup.js';

describe('amount math', () => {
  it('converts decimals exactly', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('1.50', 2)).toBe(150n);
    expect(() => toBaseUnits('1.0000001', 6)).toThrow();
    expect(() => toBaseUnits('-1', 6)).toThrow();
    expect(fromBaseUnits(1_500_000n, 6)).toBe('1.5');
    expect(fromBaseUnits('1000000000000000000', 18)).toBe('1');
    expect(fromBaseUnits(0n, 6)).toBe('0');
  });
  it('quotes rounding up so the merchant never receives less', () => {
    expect(quoteAmount('10', '1', 6, 6)).toBe(10_000_000n);
    // 10 USD at 3 USD/ETH = 3.333333333.. -> 3.33333334 (8 display decimals) in wei
    expect(quoteAmount('10', '3', 18, 8)).toBe(3_333_333_340_000_000_000n);
    expect(quoteAmount('1', '0.1234', 6, 6)).toBe(8_103_728n);
  });
  it('applies underpay tolerance', () => {
    expect(applyTolerance(1000n, 0)).toBe(1000n);
    expect(applyTolerance(1000n, 0.5)).toBe(995n);
  });
});

describe('invoice state machine', () => {
  const base = { payAmount: 100n, confirmed: 0n, pending: 0n, expiresAt: new Date(2000), now: new Date(1000), tolerancePercent: 0 };
  it('walks pending -> confirming -> paid', () => {
    expect(computeStatus({ ...base, current: 'pending' })).toBe('pending');
    expect(computeStatus({ ...base, current: 'pending', pending: 100n })).toBe('confirming');
    expect(computeStatus({ ...base, current: 'confirming', confirmed: 100n })).toBe('paid');
    expect(computeStatus({ ...base, current: 'pending', confirmed: 150n })).toBe('paid');
  });
  it('handles partial, expiry, late payment and terminal states', () => {
    expect(computeStatus({ ...base, current: 'pending', pending: 40n })).toBe('partially_paid');
    expect(computeStatus({ ...base, current: 'pending', now: new Date(3000) })).toBe('expired');
    expect(computeStatus({ ...base, current: 'expired', now: new Date(3000), confirmed: 100n })).toBe('paid');
    expect(computeStatus({ ...base, current: 'confirming', now: new Date(3000), pending: 100n })).toBe('confirming');
    expect(computeStatus({ ...base, current: 'paid', confirmed: 0n })).toBe('paid');
    expect(computeStatus({ ...base, current: 'cancelled', confirmed: 100n })).toBe('cancelled');
    // reorg removed the pending deposit
    expect(computeStatus({ ...base, current: 'confirming' })).toBe('pending');
  });
});

describe('fees and settlement schedule', () => {
  it('computes fees with 3-decimal percentages, rounding down', () => {
    expect(computeFee(100_000_000n, '1')).toBe(1_000_000n);
    expect(computeFee(100_000_000n, '1.25')).toBe(1_250_000n);
    expect(computeFee(999n, '0.5')).toBe(4n);
    expect(computeFee(100n, '0')).toBe(0n);
  });
  it('finds the last scheduled moment', () => {
    const now = new Date('2026-10-07T10:00:00Z'); // Wednesday
    expect(lastScheduledSettlement('daily', 0, 6, now)?.toISOString()).toBe('2026-10-07T06:00:00.000Z');
    expect(lastScheduledSettlement('daily', 0, 12, now)?.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(lastScheduledSettlement('weekly', 1, 6, now)?.toISOString()).toBe('2026-10-05T06:00:00.000Z'); // Monday
    expect(lastScheduledSettlement('manual', 1, 6, now)).toBeNull();
  });
  it('is due once per period', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    const m = { settlement_schedule: 'daily' as const, settlement_weekday: 1, created_at: new Date('2026-01-01'), last_settled_at: null as Date | null };
    expect(isSettlementDue(m, 6, now)).toBe(true);
    expect(isSettlementDue({ ...m, last_settled_at: new Date('2026-10-07T06:05:00Z') }, 6, now)).toBe(false);
    expect(isSettlementDue({ ...m, last_settled_at: new Date('2026-10-06T06:05:00Z') }, 6, now)).toBe(true);
    expect(isSettlementDue({ ...m, settlement_schedule: 'manual' }, 6, now)).toBe(false);
  });
});

describe('webhook signatures', () => {
  it('signs and verifies, rejecting tampering and replays', () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const body = '{"event":"invoice.paid"}';
    const sig = signPayload('whsec_x', ts, body);
    expect(verifySignature('whsec_x', body, String(ts), sig, 300, now)).toBe(true);
    expect(verifySignature('whsec_x', body + ' ', String(ts), sig, 300, now)).toBe(false);
    expect(verifySignature('whsec_y', body, String(ts), sig, 300, now)).toBe(false);
    expect(verifySignature('whsec_x', body, String(ts - 1000), signPayload('whsec_x', ts - 1000, body), 300, now)).toBe(false);
  });
});

describe('HD wallets', () => {
  const s = new SigningWallet(TEST_MNEMONIC);
  it('matches standard BIP44 vectors', () => {
    expect(new WatchOnlyWallet('evm', s.accountXpub('evm')).deriveAddress(0)).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(new WatchOnlyWallet('tron', s.accountXpub('tron')).deriveAddress(0)).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });
  it('watch-only and signing derivations agree', () => {
    const w = new WatchOnlyWallet('evm', s.accountXpub('evm'));
    for (const i of [1, 7, 1234]) expect(w.deriveAddress(i)).toBe(s.privateKey('evm', i).address);
  });
  it('rejects xprv in watch-only mode', () => {
    expect(() => new WatchOnlyWallet('evm', 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi')).toThrow();
  });
  it('implements SLIP-0010 ed25519 (official test vector 1)', () => {
    const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    expect(slip10Ed25519(seed, 'm').toString('hex')).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
    expect(slip10Ed25519(seed, "m/0'").toString('hex')).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  });
  it('validates TRON checksums', () => {
    expect(tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe('41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(() => tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toThrow();
  });
});

const usdtTrc20: AssetDef = { id: 'USDT_TRC20', symbol: 'USDT', name: '', chain: 'tron', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', priceId: 'tether', stablecoin: true, displayDecimals: 6 };
const trx: AssetDef = { ...usdtTrc20, id: 'TRX', contract: undefined };

describe('TRON parsing', () => {
  const me = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
  it('accepts only the real USDT contract', () => {
    const base = { transaction_id: 'aa', block_timestamp: 1, from: 'TX', to: me, type: 'Transfer', value: '5000000' };
    const out = parseTrc20([
      { ...base, token_info: { address: usdtTrc20.contract!, decimals: 6 } },
      { ...base, transaction_id: 'bb', token_info: { address: 'TFakeUsdtContractxxxxxxxxxxxxxxxxx', decimals: 6 } },
      { ...base, transaction_id: 'cc', to: 'TOther', token_info: { address: usdtTrc20.contract!, decimals: 6 } },
    ], me, usdtTrc20);
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBe(5_000_000n);
  });
  it('parses TRX TransferContract and ignores TRC10 / failed txs', () => {
    const toHex = tronToHex(me);
    const tx = (txID: string, type: string, ret = 'SUCCESS') => ({
      txID, blockNumber: 10, ret: [{ contractRet: ret }],
      raw_data: { contract: [{ type, parameter: { value: { amount: 2_000_000, owner_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', to_address: toHex } } }] },
    });
    const out = parseTrx([tx('a', 'TransferContract'), tx('b', 'TransferAssetContract'), tx('c', 'TransferContract', 'REVERT')], me, trx);
    expect(out.map((o) => o.txHash)).toEqual(['a']);
    expect(out[0]!.from).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  });
});

describe('EVM log decoding', () => {
  const usdt: AssetDef = { id: 'USDT_ERC20', symbol: 'USDT', name: '', chain: 'ethereum', decimals: 6, contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', priceId: 'tether', stablecoin: true, displayDecimals: 6 };
  const to = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const log = (over: Partial<Log>): Log => ({
    address: usdt.contract!, topics: [TRANSFER_TOPIC, zeroPadValue('0x1111111111111111111111111111111111111111', 32), zeroPadValue(to, 32)],
    data: '0x' + (7_000_000).toString(16).padStart(64, '0'), blockNumber: 5, blockHash: '0xbb', transactionHash: '0xaa', index: 3, removed: false,
    ...over,
  }) as unknown as Log;
  it('decodes transfers to watched addresses with reorg-stable ids', () => {
    const out = decodeTokenLogs([log({}), log({ index: 4 }), log({ address: '0x0000000000000000000000000000000000000bad' }), log({ topics: [id('Approval(address,address,uint256)')] as never })], [usdt], new Set([to.toLowerCase()]));
    expect(out).toHaveLength(2);
    expect(out[0]!.amount).toBe(7_000_000n);
    expect(out.map((o) => o.eventIndex)).toEqual([`${usdt.contract!.toLowerCase()}:${to.toLowerCase()}:0`, `${usdt.contract!.toLowerCase()}:${to.toLowerCase()}:1`]);
  });
});

describe('TON parsing', () => {
  it('reads text comments', () => {
    const body = beginCell().storeUint(0, 32).storeStringTail('ABC123').endCell().toBoc().toString('base64');
    expect(commentFromBody(body)).toBe('ABC123');
    expect(commentFromBody(beginCell().storeUint(5, 32).endCell().toBoc().toString('base64'))).toBeNull();
  });
  it('parses jetton internal_transfer with inline and ref payloads', () => {
    const from = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
    const head = () => beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(1, 64).storeCoins(12_500_000n).storeAddress(from).storeAddress(from).storeCoins(1n);
    const comment = beginCell().storeUint(0, 32).storeStringTail('MEMO42').endCell();
    const inline = head().storeBit(0).storeSlice(comment.beginParse()).endCell().toBoc().toString('base64');
    const ref = head().storeBit(1).storeRef(comment).endCell().toBoc().toString('base64');
    for (const b of [inline, ref]) {
      const t = parseInternalTransfer(b)!;
      expect(t.amount).toBe(12_500_000n);
      expect(t.comment).toBe('MEMO42');
      expect(Address.parse(t.from!).equals(from)).toBe(true);
    }
    expect(parseInternalTransfer(beginCell().storeUint(0x7362d09c, 32).endCell().toBoc().toString('base64'))).toBeNull();
  });
});

describe('toncenter client', () => {
  it('spaces requests without an API key and retries a 429 once', async () => {
    const { vi } = await import('vitest');
    const { toncenterApi } = await import('../src/watchers/ton.js');
    const times: number[] = [];
    vi.stubGlobal('fetch', async () => {
      times.push(Date.now());
      return times.length === 2
        ? new Response('{"code":429}', { status: 429 })
        : new Response(JSON.stringify({ transactions: [] }), { status: 200 });
    });
    const api = toncenterApi('https://toncenter.test', undefined);
    await Promise.all([api.transactions('a', undefined, 1, 1), api.transactions('b', undefined, 1, 1)]);
    vi.unstubAllGlobals();
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1050);
  }, 15000);
});

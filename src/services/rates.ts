import { config } from '../config.js';
import { normalizeDecimal } from '../lib/amount.js';
import type { AssetDef, Registry } from '../chains/assets.js';

type Fetcher = (priceIds: string[], vs: string) => Promise<Record<string, number>>;

const coingecko: Fetcher = async (priceIds, vs) => {
  const url = new URL(`${config.PRICE_API_URL}/simple/price`);
  url.searchParams.set('ids', priceIds.join(','));
  url.searchParams.set('vs_currencies', vs);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.PRICE_API_KEY) headers['x-cg-demo-api-key'] = config.PRICE_API_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Price API HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, Record<string, number>>;
  const out: Record<string, number> = {};
  for (const id of priceIds) {
    const p = body[id]?.[vs];
    if (typeof p === 'number' && p > 0) out[id] = p;
  }
  return out;
};

export class RateService {
  private cache = new Map<string, { value: number; at: number }>();

  constructor(
    private readonly registry: Registry,
    private readonly fetcher: Fetcher = coingecko,
    private readonly ttlMs = config.PRICE_CACHE_SECONDS * 1000,
    private readonly stablePeg = config.STABLECOIN_USD_PEG,
  ) {}

  /** Is `currency` a crypto symbol we know (USDT, TON, ...)? */
  cryptoBySymbol(currency: string): AssetDef | undefined {
    return this.registry.assets.find((a) => a.symbol === currency.toUpperCase());
  }

  private async price(priceId: string, vs: string): Promise<number> {
    if (this.stablePeg && priceId === 'tether' && vs === 'usd') return 1;
    const key = `${priceId}:${vs}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const prices = await this.fetcher([priceId], vs);
    const value = prices[priceId];
    if (!value) throw new Error(`No price for ${priceId}/${vs}`);
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** How many units of `priceCurrency` one unit of `asset` is worth, as a decimal string. */
  async rate(asset: AssetDef, priceCurrency: string): Promise<string> {
    const cur = priceCurrency.toUpperCase();
    if (cur === asset.symbol) return '1';
    const crypto = this.cryptoBySymbol(cur);
    if (crypto) {
      if (crypto.priceId === asset.priceId) return '1';
      const [a, b] = await Promise.all([this.price(asset.priceId, 'usd'), this.price(crypto.priceId, 'usd')]);
      return normalizeDecimal(a / b);
    }
    return normalizeDecimal(await this.price(asset.priceId, cur.toLowerCase()));
  }
}

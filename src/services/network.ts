import { fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import type { Queryable } from '../db.js';
import { applyOutboundProxy, maskProxyUrl, parseProxyUrl, proxyDispatcher } from '../lib/proxy.js';

const KEY = 'outbound_proxy';

export interface ProxySetting {
  /** Effective proxy URL, or null for direct connections. */
  url: string | null;
  /** Where it comes from: the admin panel, .env (OUTBOUND_PROXY), or nothing set. */
  source: 'panel' | 'env' | 'none';
}

export async function getProxySetting(db: Queryable): Promise<ProxySetting> {
  const { rows } = await db.query<{ value: { url: string | null } }>('SELECT value FROM system_settings WHERE key = $1', [KEY]);
  if (rows[0]) return { url: rows[0].value.url, source: 'panel' };
  return config.OUTBOUND_PROXY ? { url: config.OUTBOUND_PROXY, source: 'env' } : { url: null, source: 'none' };
}

/** Saves the proxy (null = direct). Keeps the stored password when `url` is the masked form of it. */
export async function setProxySetting(db: Queryable, url: string | null): Promise<string | null> {
  if (url) {
    const current = await getProxySetting(db);
    if (url.includes('***') && current.url && maskProxyUrl(current.url) === url.replace(/\/$/, '')) url = current.url;
    parseProxyUrl(url);
  }
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify({ url: url || null })],
  );
  return url || null;
}

/**
 * Applies the stored proxy now and re-checks it every `intervalMs`, so a change in the admin panel
 * reaches the worker and signer processes without a restart.
 */
export async function syncOutboundProxy(db: Queryable, log: (msg: string) => void, intervalMs = 30_000): Promise<() => void> {
  const tick = async () => {
    try {
      applyOutboundProxy((await getProxySetting(db)).url, log);
    } catch (err) {
      log(`outbound proxy not applied: ${(err as Error).message}`);
    }
  };
  await tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface ConnectivityResult {
  name: string;
  host: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

/** The outside services this platform depends on, as configured. */
function targets(): { name: string; url: string; init?: { method: string; headers?: Record<string, string>; body?: string } }[] {
  const list: ReturnType<typeof targets> = [];
  if (config.TRON_ENABLED) list.push({ name: 'TRON (TronGrid)', url: `${config.TRON_API_URL}/wallet/getnowblock`, init: { method: 'POST' } });
  const rpc = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' };
  if (config.BSC_RPC_URL) list.push({ name: 'BSC RPC', url: config.BSC_RPC_URL, init: rpc });
  if (config.ETH_RPC_URL) list.push({ name: 'Ethereum RPC', url: config.ETH_RPC_URL, init: rpc });
  if (config.POLYGON_RPC_URL) list.push({ name: 'Polygon RPC', url: config.POLYGON_RPC_URL, init: rpc });
  if (config.TON_ENABLED) list.push({ name: 'TON (toncenter)', url: `${config.TON_API_URL}/masterchainInfo` });
  list.push({ name: 'Prices (CoinGecko)', url: `${config.PRICE_API_URL}/ping` });
  list.push({ name: 'Telegram', url: 'https://api.telegram.org/' });
  return list;
}

/** Tries every outside service through `proxyUrl` (null = direct). Any HTTP answer counts as reachable. */
export async function testConnectivity(proxyUrl: string | null, timeoutMs = 12_000): Promise<ConnectivityResult[]> {
  const dispatcher = proxyDispatcher(proxyUrl);
  try {
    return await Promise.all(
      targets().map(async (t) => {
        const started = Date.now();
        const host = new URL(t.url).host;
        try {
          const res = await undiciFetch(t.url, { ...t.init, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
          await res.body?.cancel();
          return { name: t.name, host, ok: true, status: res.status, ms: Date.now() - started };
        } catch (err) {
          const e = err as Error & { cause?: Error };
          const msg = e.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : (e.cause?.message ?? e.message);
          return { name: t.name, host, ok: false, ms: Date.now() - started, error: msg };
        }
      }),
    );
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

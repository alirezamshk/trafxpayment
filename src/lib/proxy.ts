import http from 'node:http';
import https from 'node:https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Route every outbound HTTP(S) call through one proxy (needed where blockchain APIs are
 * unreachable directly, e.g. servers inside Iran). Covers global fetch (watchers, rates,
 * webhooks) and node:http/https default agents (ethers, TronWeb and TonClient via axios).
 *
 * We deliberately read OUTBOUND_PROXY rather than HTTPS_PROXY: axios picks up HTTPS_PROXY on
 * its own and its built-in proxying of https targets is unreliable.
 */
export function installOutboundProxy(url: string | undefined, log: (msg: string) => void = console.log): boolean {
  if (!url) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OUTBOUND_PROXY must be an http:// or https:// proxy URL (got ${parsed.protocol})`);
  }
  setGlobalDispatcher(new ProxyAgent(url));
  https.globalAgent = new HttpsProxyAgent(url, { keepAlive: true });
  http.globalAgent = new HttpProxyAgent(url, { keepAlive: true });
  log(`outbound HTTP(S) goes through proxy ${parsed.host}`);
  return true;
}

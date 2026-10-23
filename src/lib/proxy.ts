import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

/**
 * Outbound proxy for every call to the outside world (blockchain APIs, prices, Telegram, merchant
 * webhooks) — needed where those hosts are unreachable directly, e.g. servers inside Iran.
 * Covers global fetch and the node:http/https default agents (ethers, TronWeb and TonClient via axios).
 *
 * Configured in the admin panel (stored in the DB) with OUTBOUND_PROXY in .env as the initial
 * default. We never use HTTPS_PROXY: axios picks that up on its own and proxies https targets badly.
 */

const PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks:'];
const isSocks = (u: URL) => u.protocol.startsWith('socks');

/** Validates a proxy URL; returns it normalised or throws with a readable message. */
export function parseProxyUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Not a valid URL, e.g. socks5://1.2.3.4:1080 or http://user:pass@1.2.3.4:3128');
  }
  if (!PROTOCOLS.includes(u.protocol)) throw new Error(`Unsupported proxy type ${u.protocol} (use http, https or socks5)`);
  if (!u.hostname || !u.port) throw new Error('The proxy URL needs a host and a port');
  return u;
}

/** Inside a container 127.0.0.1 is the container itself; a proxy on the host is host.docker.internal. */
export function reachableFromHere(u: URL): URL {
  const inContainer = existsSync('/.dockerenv');
  if (inContainer && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    const copy = new URL(u.toString());
    copy.hostname = 'host.docker.internal';
    return copy;
  }
  return u;
}

export function maskProxyUrl(raw: string | null): string | null {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function socksOptions(u: URL) {
  return {
    host: u.hostname,
    port: Number(u.port),
    type: (u.protocol === 'socks4:' ? 4 : 5) as 4 | 5,
    userId: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/** An undici dispatcher (for fetch) that goes through the proxy, or a direct one for null. */
export function proxyDispatcher(raw: string | null): Dispatcher {
  if (!raw) return new Agent();
  const u = reachableFromHere(parseProxyUrl(raw));
  if (!isSocks(u)) return new ProxyAgent(u.toString());
  const proxy = socksOptions(u);
  return new Agent({
    connect: (opts: { hostname: string; port?: string; protocol: string; servername?: string | null }, cb: (err: Error | null, socket: unknown) => void) => {
      const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
      SocksClient.createConnection({ proxy, command: 'connect', destination: { host: opts.hostname, port }, timeout: 15000 })
        .then(({ socket }) => {
          if (opts.protocol !== 'https:') return cb(null, socket);
          const secure = tls.connect({ socket, servername: opts.servername || opts.hostname, ALPNProtocols: ['http/1.1'] });
          secure.once('secureConnect', () => cb(null, secure));
          secure.once('error', (err) => cb(err, null));
        })
        .catch((err: Error) => cb(err, null));
    },
  } as ConstructorParameters<typeof Agent>[0]);
}

let applied: string | null | undefined;

/** Routes this process's outbound HTTP(S) through `raw` (null = direct). Returns true if it changed. */
export function applyOutboundProxy(raw: string | null, log: (msg: string) => void = console.log): boolean {
  if (raw === applied) return false;
  setGlobalDispatcher(proxyDispatcher(raw));
  if (raw) {
    const u = reachableFromHere(parseProxyUrl(raw)).toString();
    if (u.startsWith('socks')) {
      const agent = new SocksProxyAgent(u, { keepAlive: true });
      https.globalAgent = agent as unknown as https.Agent;
      http.globalAgent = agent as unknown as http.Agent;
    } else {
      https.globalAgent = new HttpsProxyAgent(u, { keepAlive: true }) as unknown as https.Agent;
      http.globalAgent = new HttpProxyAgent(u, { keepAlive: true }) as unknown as http.Agent;
    }
  } else {
    https.globalAgent = new https.Agent({ keepAlive: true });
    http.globalAgent = new http.Agent({ keepAlive: true });
  }
  applied = raw;
  log(raw ? `outbound connections go through proxy ${maskProxyUrl(raw)}` : 'outbound connections are direct (no proxy)');
  return true;
}

import { BlockList, isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { findMerchantByApiKey, getMerchant, resolveSession, type Merchant } from '../services/merchants.js';

export const SESSION_COOKIE = 'txp_session';

declare module 'fastify' {
  interface FastifyRequest {
    merchant?: Merchant;
    adminId?: string;
  }
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = config.PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function unauthorized(reply: FastifyReply, message = 'Unauthorized') {
  return reply.code(401).send({ error: { code: 'unauthorized', message } });
}

/** "1.2.3.4", "2001:db8::1" or a CIDR range such as "10.0.0.0/24". */
export function isValidIpRule(rule: string): boolean {
  const [ip = '', bits] = rule.split('/');
  const v = isIP(ip);
  if (!v) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (v === 4 ? 32 : 128);
}

export function ipAllowed(ip: string, rules: string[]): boolean {
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
  const list = new BlockList();
  for (const r of rules) {
    const [a = '', bits] = r.split('/');
    const t = isIP(a) === 6 ? 'ipv6' : 'ipv4';
    if (bits !== undefined) list.addSubnet(a, Number(bits), t);
    else list.addAddress(a, t);
  }
  return list.check(addr, family);
}

/** Server-to-server API: `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization;
  const key = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : (req.headers['x-api-key'] as string | undefined);
  if (!key) return unauthorized(reply, 'Missing API key');
  const merchant = await findMerchantByApiKey(pool, key);
  if (!merchant) return unauthorized(reply, 'Invalid API key');
  if (merchant.allowed_ips?.length && !ipAllowed(req.ip, merchant.allowed_ips)) {
    return reply.code(403).send({ error: { code: 'ip_not_allowed', message: `API key not allowed from ${req.ip}` } });
  }
  req.merchant = merchant;
}

/**
 * Panel (browser) auth via HttpOnly SameSite=Strict cookie. Mutations must be JSON, which a
 * cross-site HTML form cannot send, giving CSRF protection on top of SameSite.
 */
function csrfOk(req: FastifyRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  return (req.headers['content-type'] ?? '').startsWith('application/json');
}

export async function requireMerchantSession(req: FastifyRequest, reply: FastifyReply) {
  const token = readCookie(req, SESSION_COOKIE);
  const s = token ? await resolveSession(pool, token) : undefined;
  if (!s || s.role !== 'merchant') return unauthorized(reply);
  if (!csrfOk(req)) return reply.code(415).send({ error: { code: 'json_required', message: 'Use application/json' } });
  const m = await getMerchant(pool, s.subjectId);
  if (!m || !m.is_active) return unauthorized(reply, 'Account disabled');
  req.merchant = m;
}

export async function requireAdminSession(req: FastifyRequest, reply: FastifyReply) {
  const token = readCookie(req, SESSION_COOKIE);
  const s = token ? await resolveSession(pool, token) : undefined;
  if (!s || s.role !== 'admin') return unauthorized(reply);
  if (!csrfOk(req)) return reply.code(415).send({ error: { code: 'json_required', message: 'Use application/json' } });
  req.adminId = s.subjectId;
}

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { Queryable } from '../db.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Merchant {
  id: string;
  name: string;
  email: string;
  webhook_url: string | null;
  webhook_secret: string;
  fee_percent: string;
  settlement_schedule: 'daily' | 'weekly' | 'manual';
  settlement_weekday: number;
  fee_payer: 'merchant' | 'customer';
  totp_enabled: boolean;
  last_settled_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

const MERCHANT_COLS = `id, name, email, webhook_url, webhook_secret, fee_percent, settlement_schedule,
  settlement_weekday, last_settled_at, is_active, created_at, fee_payer, totp_enabled`;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function validatePassword(pw: string): void {
  if (pw.length < 10) throw new Error('Password must be at least 10 characters');
}

// ------------------------------------------------------------------ merchants

export async function createMerchant(
  db: Queryable,
  input: { name: string; email: string; password: string; webhookUrl?: string; feePercent?: number },
): Promise<Merchant> {
  validatePassword(input.password);
  const { rows } = await db.query<Merchant>(
    `INSERT INTO merchants (name, email, password_hash, webhook_url, webhook_secret, fee_percent)
     VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING ${MERCHANT_COLS}`,
    [
      input.name,
      input.email,
      await hashPassword(input.password),
      input.webhookUrl ?? null,
      `whsec_${randomBytes(32).toString('base64url')}`,
      input.feePercent ?? config.DEFAULT_FEE_PERCENT,
    ],
  );
  return rows[0]!;
}

export async function getMerchant(db: Queryable, id: string): Promise<Merchant | undefined> {
  const { rows } = await db.query<Merchant>(`SELECT ${MERCHANT_COLS} FROM merchants WHERE id = $1`, [id]);
  return rows[0];
}

export async function listMerchants(db: Queryable): Promise<Merchant[]> {
  const { rows } = await db.query<Merchant>(`SELECT ${MERCHANT_COLS} FROM merchants ORDER BY created_at DESC`);
  return rows;
}

export async function authenticateMerchant(db: Queryable, email: string, password: string): Promise<Merchant | undefined> {
  const { rows } = await db.query<Merchant & { password_hash: string }>(
    `SELECT ${MERCHANT_COLS}, password_hash FROM merchants WHERE email = lower($1)`,
    [email],
  );
  const m = rows[0];
  if (!m || !m.is_active || !(await verifyPassword(password, m.password_hash))) return undefined;
  const { password_hash: _ignored, ...merchant } = m;
  return merchant;
}

export async function authenticateAdmin(db: Queryable, email: string, password: string): Promise<{ id: string } | undefined> {
  const { rows } = await db.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM admins WHERE email = lower($1)',
    [email],
  );
  const a = rows[0];
  return a && (await verifyPassword(password, a.password_hash)) ? { id: a.id } : undefined;
}

export async function createAdmin(db: Queryable, email: string, password: string): Promise<void> {
  validatePassword(password);
  await db.query(
    `INSERT INTO admins (email, password_hash) VALUES (lower($1), $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, await hashPassword(password)],
  );
}

// ------------------------------------------------------------------ API keys

export interface ApiKeyRow {
  id: string;
  label: string;
  key_prefix: string;
  allowed_ips: string[] | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export async function createApiKey(
  db: Queryable,
  merchantId: string,
  label = 'default',
  allowedIps: string[] | null = null,
): Promise<{ key: string; row: ApiKeyRow }> {
  const key = `txp_${randomBytes(32).toString('base64url')}`;
  const { rows } = await db.query<ApiKeyRow>(
    `INSERT INTO api_keys (merchant_id, label, key_hash, key_prefix, allowed_ips) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, label, key_prefix, allowed_ips, revoked_at, last_used_at, created_at`,
    [merchantId, label, sha256(key), key.slice(0, 10), allowedIps],
  );
  return { key, row: rows[0]! };
}

export async function listApiKeys(db: Queryable, merchantId: string): Promise<ApiKeyRow[]> {
  const { rows } = await db.query<ApiKeyRow>(
    `SELECT id, label, key_prefix, allowed_ips, revoked_at, last_used_at, created_at FROM api_keys
     WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchantId],
  );
  return rows;
}

export async function revokeApiKey(db: Queryable, merchantId: string, keyId: string): Promise<boolean> {
  const r = await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL', [
    keyId,
    merchantId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function findMerchantByApiKey(
  db: Queryable,
  apiKey: string,
): Promise<(Merchant & { allowed_ips: string[] | null }) | undefined> {
  const { rows } = await db.query<Merchant & { key_id: string; allowed_ips: string[] | null }>(
    `SELECT ${MERCHANT_COLS.split(',').map((c) => 'm.' + c.trim()).join(', ')}, k.id AS key_id, k.allowed_ips
     FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.is_active`,
    [sha256(apiKey)],
  );
  const m = rows[0];
  if (!m) return undefined;
  await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [m.key_id]);
  const { key_id: _k, ...merchant } = m;
  return merchant;
}

// ------------------------------------------------------------------ sessions (panel login)

export type SessionRole = 'merchant' | 'admin';

export async function createSession(db: Queryable, role: SessionRole, subjectId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, role, subject_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), role, subjectId, config.SESSION_TTL_HOURS],
  );
  return token;
}

export async function resolveSession(db: Queryable, token: string): Promise<{ role: SessionRole; subjectId: string } | undefined> {
  const { rows } = await db.query<{ role: SessionRole; subject_id: string }>(
    'SELECT role, subject_id FROM sessions WHERE token_hash = $1 AND expires_at > now()',
    [sha256(token)],
  );
  const s = rows[0];
  return s ? { role: s.role, subjectId: s.subject_id } : undefined;
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

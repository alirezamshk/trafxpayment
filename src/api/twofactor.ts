import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { pool } from '../db.js';
import { generateSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { audit } from '../services/audit.js';
import { httpError, parse } from './util.js';

export type Role = 'merchant' | 'admin';
const TABLE: Record<Role, string> = { merchant: 'merchants', admin: 'admins' };
const ISSUER = 'TrafxPayment';

interface TotpState {
  email: string;
  totp_secret: string | null;
  totp_enabled: boolean;
  totp_last_step: string | null;
}

async function state(role: Role, id: string): Promise<TotpState> {
  const { rows } = await pool.query<TotpState>(
    `SELECT email, totp_secret, totp_enabled, totp_last_step FROM ${TABLE[role]} WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw httpError(404, 'not_found', 'Account not found');
  return rows[0];
}

/** Verifies a code and burns its time step so it cannot be replayed. */
async function consume(role: Role, id: string, s: TotpState, code: string | undefined, secret = s.totp_secret): Promise<boolean> {
  if (!code || !secret) return false;
  const step = verifyTotp(secret, code, s.totp_last_step === null ? null : Number(s.totp_last_step));
  if (step === null) return false;
  await pool.query(`UPDATE ${TABLE[role]} SET totp_last_step = $2 WHERE id = $1`, [id, step]);
  return true;
}

/**
 * Second factor for login and for sensitive actions. If the account has 2FA enabled, a valid code
 * must be supplied (body `otp` on login, `X-OTP` header otherwise); without 2FA this is a no-op.
 */
export async function requireOtp(role: Role, id: string, code: string | undefined): Promise<void> {
  const s = await state(role, id);
  if (!s.totp_enabled) return;
  if (!code) throw httpError(401, 'otp_required', 'Two-factor code required');
  if (!(await consume(role, id, s, code))) throw httpError(401, 'otp_invalid', 'Invalid or already used two-factor code');
}

export function otpFromRequest(req: FastifyRequest): string | undefined {
  const h = req.headers['x-otp'];
  return typeof h === 'string' && h.trim() ? h.trim() : undefined;
}

/** Enrollment endpoints; mount under an already-authenticated prefix. */
export function twoFactorRoutes(role: Role, subjectId: (req: FastifyRequest) => string) {
  return async (app: FastifyInstance) => {
    app.get('/2fa', async (req) => ({ enabled: (await state(role, subjectId(req))).totp_enabled }));

    /** Starts (or restarts) enrollment: a fresh secret that is only active after /2fa/enable. */
    app.post('/2fa/setup', async (req) => {
      const id = subjectId(req);
      const s = await state(role, id);
      if (s.totp_enabled) throw httpError(409, 'already_enabled', 'Two-factor authentication is already enabled');
      const secret = generateSecret();
      await pool.query(`UPDATE ${TABLE[role]} SET totp_secret = $2, totp_last_step = NULL WHERE id = $1`, [id, secret]);
      const uri = otpauthUri(secret, s.email, ISSUER);
      return { secret, otpauth_uri: uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    });

    app.post('/2fa/enable', async (req) => {
      const { code } = parse(z.object({ code: z.string() }), req.body);
      const id = subjectId(req);
      const s = await state(role, id);
      if (s.totp_enabled) return { ok: true };
      if (!s.totp_secret) throw httpError(400, 'setup_required', 'Start setup first');
      if (!(await consume(role, id, s, code))) throw httpError(400, 'otp_invalid', 'Code does not match; check the time on your phone');
      await pool.query(`UPDATE ${TABLE[role]} SET totp_enabled = TRUE WHERE id = $1`, [id]);
      await audit(pool, { actorType: role, actorId: id, merchantId: role === 'merchant' ? id : null, action: '2fa.enabled', ip: req.ip });
      return { ok: true };
    });

    app.post('/2fa/disable', async (req) => {
      const { code } = parse(z.object({ code: z.string() }), req.body);
      const id = subjectId(req);
      const s = await state(role, id);
      if (!s.totp_enabled) return { ok: true };
      if (!(await consume(role, id, s, code))) throw httpError(401, 'otp_invalid', 'Invalid two-factor code');
      await pool.query(`UPDATE ${TABLE[role]} SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1`, [id]);
      await audit(pool, { actorType: role, actorId: id, merchantId: role === 'merchant' ? id : null, action: '2fa.disabled', ip: req.ip });
      return { ok: true };
    });
  };
}

/** For admins resetting a merchant who lost their phone. */
export async function resetTwoFactor(role: Role, id: string): Promise<void> {
  await pool.query(`UPDATE ${TABLE[role]} SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = NULL WHERE id = $1`, [id]);
}

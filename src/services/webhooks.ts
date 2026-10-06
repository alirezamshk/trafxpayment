import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db.js';

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Merchant-side verification helper (also exported for SDK/docs use).
 * Rejects signatures older than `toleranceSeconds` to prevent replay.
 */
export function verifySignature(
  secret: string,
  body: string,
  timestampHeader: string,
  signatureHeader: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, ts, body), 'hex');
  const given = Buffer.from(signatureHeader, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function enqueueWebhook(
  db: Queryable,
  merchantId: string,
  invoiceId: string | null,
  event: string,
  data: unknown,
): Promise<void> {
  const payload = { id: crypto.randomUUID(), event, created_at: new Date().toISOString(), data };
  await db.query(
    `INSERT INTO webhook_deliveries (id, merchant_id, invoice_id, event, payload) VALUES ($1, $2, $3, $4, $5)`,
    [payload.id, merchantId, invoiceId, event, JSON.stringify(payload)],
  );
}

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 6h. */
export function nextRetryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 6 * 3600);
}

import type { Queryable } from '../db.js';

export interface AuditEntry {
  actorType: 'admin' | 'merchant' | 'api' | 'system';
  actorId?: string | null;
  merchantId?: string | null;
  action: string;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/** Append-only record of security-relevant actions (who, what, when, from where). */
export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_type, actor_id, merchant_id, action, details, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.actorType, e.actorId ?? null, e.merchantId ?? null, e.action, JSON.stringify(e.details ?? {}), e.ip ?? null],
  );
}

export async function auditList(db: Queryable, opts: { merchantId?: string; limit?: number } = {}) {
  const { rows } = await db.query(
    `SELECT id, actor_type, actor_id, merchant_id, action, details, ip, created_at FROM audit_log
     ${opts.merchantId ? 'WHERE merchant_id = $2' : ''} ORDER BY id DESC LIMIT $1`,
    opts.merchantId ? [opts.limit ?? 200, opts.merchantId] : [opts.limit ?? 200],
  );
  return rows;
}

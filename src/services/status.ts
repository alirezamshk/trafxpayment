import { applyTolerance } from '../lib/amount.js';

export type InvoiceStatus = 'pending' | 'confirming' | 'partially_paid' | 'paid' | 'expired' | 'cancelled';

export interface StatusInput {
  current: InvoiceStatus;
  payAmount: bigint | null;
  confirmed: bigint;
  pending: bigint;
  expiresAt: Date;
  now: Date;
  tolerancePercent: number;
}

/**
 * Pure invoice state machine.
 *
 *   pending ──deposit seen──▶ confirming ──confirmations reached──▶ paid
 *      │                          │
 *      │ (less than due)          └── reorg / dropped ──▶ back to pending / partially_paid
 *      ▼
 *   partially_paid  (payer may top up until expiry; stays watched for the late window)
 *
 *   pending ──expires_at passed, nothing received──▶ expired (a late full payment still moves it to paid)
 *
 * `paid` and `cancelled` are terminal.
 */
export function computeStatus(i: StatusInput): InvoiceStatus {
  if (i.current === 'paid' || i.current === 'cancelled') return i.current;
  if (i.payAmount === null) return i.now > i.expiresAt ? 'expired' : 'pending';

  const required = applyTolerance(i.payAmount, i.tolerancePercent);
  if (i.confirmed >= required) return 'paid';
  if (i.confirmed + i.pending >= required) return 'confirming';
  if (i.confirmed + i.pending > 0n) return 'partially_paid';
  return i.now > i.expiresAt ? 'expired' : 'pending';
}

/** Statuses for which the watcher must keep looking at the invoice address. */
export const WATCHED_STATUSES: InvoiceStatus[] = ['pending', 'confirming', 'partially_paid', 'expired'];

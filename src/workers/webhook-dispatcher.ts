import { config } from '../config.js';
import { pool, withTx } from '../db.js';
import { nextRetryDelaySeconds, signPayload } from '../services/webhooks.js';
import type { Logger, Watcher } from '../watchers/types.js';

interface Due {
  id: string;
  payload: unknown;
  attempts: number;
  webhook_url: string | null;
  webhook_secret: string;
}

export class WebhookDispatcher implements Watcher {
  readonly name = 'webhooks';
  readonly intervalMs = 3000;

  constructor(
    private readonly log: Logger,
    private readonly send: typeof fetch = fetch,
  ) {}

  async tick(): Promise<void> {
    // Lease a batch so parallel workers never deliver the same event twice at once.
    const batch = await withTx(async (db) => {
      const { rows } = await db.query<Due>(
        `SELECT w.id, w.payload, w.attempts, m.webhook_url, m.webhook_secret
         FROM webhook_deliveries w JOIN merchants m ON m.id = w.merchant_id
         WHERE w.status = 'pending' AND w.next_attempt_at <= now()
         ORDER BY w.next_attempt_at LIMIT 50
         FOR UPDATE OF w SKIP LOCKED`,
      );
      if (rows.length) {
        await db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() + interval '2 minutes' WHERE id = ANY($1)`, [
          rows.map((r) => r.id),
        ]);
      }
      return rows;
    });
    await Promise.all(batch.map((d) => this.deliver(d)));
  }

  private async deliver(d: Due): Promise<void> {
    if (!d.webhook_url) {
      await pool.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'no webhook_url configured' WHERE id = $1`, [d.id]);
      return;
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    const attempt = d.attempts + 1;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await this.send(d.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'TrafxPayment-Webhook/1.0',
          'x-webhook-id': d.id,
          'x-webhook-timestamp': String(ts),
          'x-webhook-signature': signPayload(d.webhook_secret, ts, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.WEBHOOK_TIMEOUT_MS),
      });
      statusCode = res.status;
      if (res.status >= 200 && res.status < 300) {
        await pool.query(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, last_status_code = $3, delivered_at = now(), last_error = NULL
           WHERE id = $1`,
          [d.id, attempt, statusCode],
        );
        return;
      }
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message;
    }
    const giveUp = attempt >= config.WEBHOOK_MAX_ATTEMPTS;
    await pool.query(
      `UPDATE webhook_deliveries SET attempts = $2, last_status_code = $3, last_error = $4,
              status = $5, next_attempt_at = now() + make_interval(secs => $6)
       WHERE id = $1`,
      [d.id, attempt, statusCode, error, giveUp ? 'failed' : 'pending', nextRetryDelaySeconds(attempt)],
    );
    this.log.warn({ webhook: d.id, attempt, error }, giveUp ? 'webhook delivery failed permanently' : 'webhook delivery failed, will retry');
  }
}

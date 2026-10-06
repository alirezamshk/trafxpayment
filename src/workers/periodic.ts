import type { InvoiceService } from '../services/invoices.js';
import type { LedgerService } from '../services/ledger.js';
import { pool } from '../db.js';
import type { Logger, Watcher } from '../watchers/types.js';

export class ExpiryWorker implements Watcher {
  readonly name = 'expiry';
  readonly intervalMs = 30_000;
  constructor(
    private readonly invoices: InvoiceService,
    private readonly log: Logger,
  ) {}
  async tick() {
    const n = await this.invoices.expireDue();
    if (n) this.log.info({ count: n }, 'invoices expired');
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  }
}

export class SettlementWorker implements Watcher {
  readonly name = 'settlement';
  readonly intervalMs = 5 * 60_000;
  constructor(
    private readonly ledger: LedgerService,
    private readonly log: Logger,
  ) {}
  async tick() {
    const payouts = await this.ledger.runSettlements();
    for (const p of payouts) this.log.info({ payout: p.id, merchant: p.merchant_id, asset: p.asset, amount: p.amount }, 'settlement payout created');
  }
}

/** Runs each job on its own interval; an error in one tick is logged and never stops the loop. */
export function runLoops(jobs: Watcher[], log: Logger): () => void {
  let stopped = false;
  for (const job of jobs) {
    const loop = async () => {
      while (!stopped) {
        const started = Date.now();
        try {
          await job.tick();
        } catch (err) {
          log.error({ job: job.name, err: (err as Error).message }, 'job tick failed');
        }
        const wait = Math.max(500, job.intervalMs - (Date.now() - started));
        await new Promise((r) => setTimeout(r, wait));
      }
    };
    void loop();
  }
  log.info({ jobs: jobs.map((j) => j.name) }, 'worker started');
  return () => {
    stopped = true;
  };
}

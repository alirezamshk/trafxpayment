import { config } from '../config.js';
import { registry, walletFor } from '../context.js';
import { InvoiceService } from './invoices.js';
import { LedgerService } from './ledger.js';
import { RateService } from './rates.js';

export const rates = new RateService(registry);
export const ledger = new LedgerService(registry);
export const invoices = new InvoiceService({
  registry,
  rates,
  ledger,
  wallet: walletFor,
  tonTreasury: config.TON_TREASURY_ADDRESS,
});

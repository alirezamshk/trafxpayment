import { config } from '../config.js';
import { registry } from '../context.js';
import { invoices, ledger } from '../services/index.js';
import { EvmWatcher, ethersRpc } from '../watchers/evm.js';
import { TonWatcher, toncenterApi } from '../watchers/ton.js';
import { TronWatcher, tronGridApi } from '../watchers/tron.js';
import { consoleLogger as log, type Watcher } from '../watchers/types.js';
import { ExpiryWorker, runLoops, SettlementWorker } from '../workers/periodic.js';
import { WebhookDispatcher } from '../workers/webhook-dispatcher.js';

const jobs: Watcher[] = [new WebhookDispatcher(log), new ExpiryWorker(invoices, log), new SettlementWorker(ledger, log)];

for (const chain of Object.values(registry.chains)) {
  if (!chain.enabled) continue;
  const assets = registry.assets.filter((a) => a.chain === chain.id);
  if (chain.family === 'evm') jobs.push(new EvmWatcher(chain, assets, invoices, ethersRpc(chain.rpcUrl!), log));
  if (chain.family === 'tron') jobs.push(new TronWatcher(chain, assets, invoices, tronGridApi(), log));
  if (chain.family === 'ton') jobs.push(new TonWatcher(chain, assets, invoices, toncenterApi(), config.TON_TREASURY_ADDRESS!, log));
}

const stop = runLoops(jobs, log);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop(); setTimeout(() => process.exit(0), 1000); });

import { config } from '../config.js';
import { registry } from '../context.js';
import { ledger } from '../services/index.js';
import { EvmSigner } from '../sweeper/evm.js';
import { ColdStorageJob, PayoutJob, SweepJob } from '../sweeper/signer.js';
import { TonSigner } from '../sweeper/ton.js';
import { TronSigner } from '../sweeper/tron.js';
import type { ChainSigner } from '../sweeper/types.js';
import { WatchOnlyWallet, SigningWallet } from '../wallet/hd.js';
import { consoleLogger as log } from '../watchers/types.js';
import { runLoops } from '../workers/periodic.js';

if (!config.SIGNER_MNEMONIC) throw new Error('SIGNER_MNEMONIC is required for the signer process');
const keys = new SigningWallet(config.SIGNER_MNEMONIC);

// Refuse to run if the mnemonic does not match the xpubs the API hands addresses out from.
for (const family of ['evm', 'tron'] as const) {
  const xpub = family === 'evm' ? config.EVM_XPUB : config.TRON_XPUB;
  if (xpub && new WatchOnlyWallet(family, xpub).deriveAddress(0) !== keys.privateKey(family, 0).address) {
    throw new Error(`SIGNER_MNEMONIC does not match ${family.toUpperCase()}_XPUB`);
  }
}

const signers: ChainSigner[] = [];
for (const chain of Object.values(registry.chains)) {
  if (!chain.enabled) continue;
  if (chain.family === 'evm') signers.push(new EvmSigner(chain, keys));
  if (chain.family === 'tron') signers.push(new TronSigner(keys));
  if (chain.family === 'ton') {
    const ton = new TonSigner(config.SIGNER_MNEMONIC);
    const { Address } = await import('@ton/core');
    if (!Address.parse(config.TON_TREASURY_ADDRESS!).equals(Address.parse(ton.hotAddress))) {
      throw new Error(`TON_TREASURY_ADDRESS must be the signer hot wallet ${ton.hotAddress}`);
    }
    signers.push(ton);
  }
}
for (const s of signers) log.info({ chain: s.chain, hotWallet: s.hotAddress }, 'signer ready');

const coldWallets: Record<string, string | undefined> = {
  tron: config.COLD_WALLET_TRON,
  ton: config.COLD_WALLET_TON,
  ethereum: config.COLD_WALLET_EVM,
  bsc: config.COLD_WALLET_EVM,
  polygon: config.COLD_WALLET_EVM,
};
for (const s of signers) {
  const cold = coldWallets[s.chain];
  if (!cold) continue;
  if (!s.validateAddress(cold)) throw new Error(`Invalid cold wallet address for ${s.chain}: ${cold}`);
  if (cold.toLowerCase() === s.hotAddress.toLowerCase()) throw new Error(`Cold wallet for ${s.chain} must differ from the hot wallet`);
  log.info({ chain: s.chain, coldWallet: cold }, 'cold storage enabled');
}

const stop = runLoops(
  [
    new SweepJob(signers, registry, ledger.settings, log),
    new PayoutJob(signers, registry, ledger, log),
    new ColdStorageJob(signers, (chain) => coldWallets[chain], registry, ledger.settings, log),
  ],
  log,
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop(); setTimeout(() => process.exit(0), 1000); });

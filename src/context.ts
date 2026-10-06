import { config } from './config.js';
import { buildRegistry, type ChainId } from './chains/assets.js';
import { WatchOnlyWallet, type KeyFamily } from './wallet/hd.js';

export const registry = buildRegistry(config);

const wallets: Partial<Record<KeyFamily, WatchOnlyWallet>> = {};
if (config.EVM_XPUB) wallets.evm = new WatchOnlyWallet('evm', config.EVM_XPUB);
if (config.TRON_XPUB) wallets.tron = new WatchOnlyWallet('tron', config.TRON_XPUB);

export function walletFor(family: KeyFamily): WatchOnlyWallet {
  const w = wallets[family];
  if (!w) throw new Error(`No xpub configured for ${family}`);
  return w;
}

export function chainDef(id: string) {
  const c = registry.chains[id as ChainId];
  if (!c) throw new Error(`Unknown chain ${id}`);
  return c;
}

import type { Config } from '../config.js';

export type ChainFamily = 'evm' | 'tron' | 'ton';
export type ChainId = 'tron' | 'ethereum' | 'bsc' | 'polygon' | 'ton';

export interface ChainDef {
  id: ChainId;
  family: ChainFamily;
  name: string;
  confirmations: number;
  enabled: boolean;
  rpcUrl?: string;
  /** Uses a shared address + memo instead of one address per invoice. */
  usesMemo: boolean;
}

export interface AssetDef {
  id: string; // e.g. USDT_TRC20
  symbol: string; // e.g. USDT
  name: string;
  chain: ChainId;
  decimals: number;
  /** Token contract / jetton master. Undefined for the chain's native coin. */
  contract?: string;
  /** CoinGecko id used for price conversion. */
  priceId: string;
  stablecoin: boolean;
  /** Decimals shown to the payer; the invoice amount is rounded up to this precision. */
  displayDecimals: number;
}

export interface Registry {
  chains: Record<ChainId, ChainDef>;
  assets: AssetDef[];
}

export function buildRegistry(cfg: Config): Registry {
  const chains: Record<ChainId, ChainDef> = {
    tron: {
      id: 'tron',
      family: 'tron',
      name: 'TRON',
      confirmations: 19, // solidified on TRON = irreversible
      enabled: cfg.TRON_ENABLED && !!cfg.TRON_XPUB,
      usesMemo: false,
    },
    ethereum: {
      id: 'ethereum',
      family: 'evm',
      name: 'Ethereum',
      confirmations: cfg.ETH_CONFIRMATIONS,
      enabled: !!cfg.ETH_RPC_URL && !!cfg.EVM_XPUB,
      rpcUrl: cfg.ETH_RPC_URL,
      usesMemo: false,
    },
    bsc: {
      id: 'bsc',
      family: 'evm',
      name: 'BNB Smart Chain',
      confirmations: cfg.BSC_CONFIRMATIONS,
      enabled: !!cfg.BSC_RPC_URL && !!cfg.EVM_XPUB,
      rpcUrl: cfg.BSC_RPC_URL,
      usesMemo: false,
    },
    polygon: {
      id: 'polygon',
      family: 'evm',
      name: 'Polygon',
      confirmations: cfg.POLYGON_CONFIRMATIONS,
      enabled: !!cfg.POLYGON_RPC_URL && !!cfg.EVM_XPUB,
      rpcUrl: cfg.POLYGON_RPC_URL,
      usesMemo: false,
    },
    ton: {
      id: 'ton',
      family: 'ton',
      name: 'TON',
      confirmations: 1, // toncenter indexes finalized masterchain blocks only
      enabled: cfg.TON_ENABLED && !!cfg.TON_TREASURY_ADDRESS,
      usesMemo: true,
    },
  };

  const assets: AssetDef[] = [
    { id: 'TRX', symbol: 'TRX', name: 'TRON', chain: 'tron', decimals: 6, priceId: 'tron', stablecoin: false, displayDecimals: 6 },
    { id: 'USDT_TRC20', symbol: 'USDT', name: 'Tether (TRC20)', chain: 'tron', decimals: 6, contract: cfg.TRON_USDT_CONTRACT, priceId: 'tether', stablecoin: true, displayDecimals: 6 },
    { id: 'ETH', symbol: 'ETH', name: 'Ether', chain: 'ethereum', decimals: 18, priceId: 'ethereum', stablecoin: false, displayDecimals: 8 },
    { id: 'USDT_ERC20', symbol: 'USDT', name: 'Tether (ERC20)', chain: 'ethereum', decimals: 6, contract: cfg.ETH_USDT_CONTRACT, priceId: 'tether', stablecoin: true, displayDecimals: 6 },
    { id: 'BNB', symbol: 'BNB', name: 'BNB', chain: 'bsc', decimals: 18, priceId: 'binancecoin', stablecoin: false, displayDecimals: 8 },
    { id: 'USDT_BEP20', symbol: 'USDT', name: 'Tether (BEP20)', chain: 'bsc', decimals: 18, contract: cfg.BSC_USDT_CONTRACT, priceId: 'tether', stablecoin: true, displayDecimals: 6 },
    { id: 'POL', symbol: 'POL', name: 'Polygon', chain: 'polygon', decimals: 18, priceId: 'polygon-ecosystem-token', stablecoin: false, displayDecimals: 6 },
    { id: 'USDT_POLYGON', symbol: 'USDT', name: 'Tether (Polygon)', chain: 'polygon', decimals: 6, contract: cfg.POLYGON_USDT_CONTRACT, priceId: 'tether', stablecoin: true, displayDecimals: 6 },
    { id: 'TON', symbol: 'TON', name: 'Toncoin', chain: 'ton', decimals: 9, priceId: 'the-open-network', stablecoin: false, displayDecimals: 6 },
    { id: 'USDT_TON', symbol: 'USDT', name: 'Tether (TON)', chain: 'ton', decimals: 6, contract: cfg.TON_USDT_MASTER, priceId: 'tether', stablecoin: true, displayDecimals: 6 },
  ];

  return { chains, assets };
}

export function enabledAssets(reg: Registry): AssetDef[] {
  return reg.assets.filter((a) => reg.chains[a.chain].enabled);
}

export function findAsset(reg: Registry, id: string): AssetDef | undefined {
  return reg.assets.find((a) => a.id === id.toUpperCase());
}

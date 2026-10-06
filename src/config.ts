import { z } from 'zod';

const boolWithDefault = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));
const bool = boolWithDefault(false);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/trafxpayment'),

  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  ADMIN_TOKEN: optionalString,

  INVOICE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  LATE_PAYMENT_WINDOW_HOURS: z.coerce.number().nonnegative().default(24),
  UNDERPAY_TOLERANCE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  // Pool addresses (invoices without customer_id) are reused after this cool-down.
  ADDRESS_POOL_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(48),
  ADDRESS_POOL_MAX: z.coerce.number().int().positive().default(1000),
  // Permanent customer addresses stay monitored this long after their last invoice.
  CUSTOMER_ADDRESS_WATCH_DAYS: z.coerce.number().nonnegative().default(30),

  // Watch-only extended public keys (account level). The API and watcher never need private keys.
  EVM_XPUB: optionalString, // m/44'/60'/0'
  TRON_XPUB: optionalString, // m/44'/195'/0'

  TRON_API_URL: z.string().default('https://api.trongrid.io'),
  TRON_API_KEY: optionalString,
  TRON_ENABLED: bool,
  TRON_USDT_CONTRACT: z.string().default('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  TRON_POLL_INTERVAL_MS: z.coerce.number().default(15000),

  ETH_RPC_URL: optionalString,
  ETH_CONFIRMATIONS: z.coerce.number().int().positive().default(12),
  ETH_USDT_CONTRACT: z.string().default('0xdAC17F958D2ee523a2206206994597C13D831ec7'),

  BSC_RPC_URL: optionalString,
  BSC_CONFIRMATIONS: z.coerce.number().int().positive().default(15),
  BSC_USDT_CONTRACT: z.string().default('0x55d398326f99059fF775485246999027B3197955'),

  POLYGON_RPC_URL: optionalString,
  POLYGON_CONFIRMATIONS: z.coerce.number().int().positive().default(64),
  POLYGON_USDT_CONTRACT: z.string().default('0xc2132D05D31c914a87C6611C10748AEb04B58e8F'),

  EVM_POLL_INTERVAL_MS: z.coerce.number().default(10000),
  EVM_MAX_BLOCKS_PER_TICK: z.coerce.number().int().positive().default(50),
  EVM_START_BLOCK_LOOKBACK: z.coerce.number().int().nonnegative().default(20),

  TON_API_URL: z.string().default('https://toncenter.com/api/v3'),
  TON_API_KEY: optionalString,
  TON_ENABLED: bool,
  TON_TREASURY_ADDRESS: optionalString,
  TON_USDT_MASTER: z.string().default('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'),
  TON_V2_RPC_URL: z.string().default('https://toncenter.com/api/v2/jsonRPC'),
  TON_POLL_INTERVAL_MS: z.coerce.number().default(10000),

  PRICE_API_URL: z.string().default('https://api.coingecko.com/api/v3'),
  PRICE_API_KEY: optionalString,
  PRICE_CACHE_SECONDS: z.coerce.number().default(60),
  STABLECOIN_USD_PEG: boolWithDefault(true),

  // Platform / settlement
  DEFAULT_FEE_PERCENT: z.coerce.number().min(0).max(99).default(1),
  SETTLEMENT_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(6),
  PAYOUT_REQUIRE_APPROVAL: boolWithDefault(true),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  // A changed payout address receives no payouts for this long (protects against account takeover).
  PAYOUT_ADDRESS_HOLD_HOURS: z.coerce.number().nonnegative().default(24),
  ALLOW_MERCHANT_SIGNUP: bool,

  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(12),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(10000),

  // Signer only (sweeper + payout sender). Keep these OFF the API/worker hosts.
  SIGNER_MNEMONIC: optionalString,
  // Cold wallets: hot-wallet balance above each asset's hot_max is moved here (unset = disabled).
  COLD_WALLET_EVM: optionalString,
  COLD_WALLET_TRON: optionalString,
  COLD_WALLET_TON: optionalString,
  COLD_INTERVAL_MS: z.coerce.number().default(10 * 60_000),
  SWEEP_INTERVAL_MS: z.coerce.number().default(60000),
  TRON_SWEEP_TRX_TOPUP: z.coerce.number().default(30),
  TRON_SWEEP_FEE_LIMIT_TRX: z.coerce.number().default(50),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();

import { keyPairFromSeed } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { SigningWallet, tonHotSeed } from '../src/wallet/hd.js';

export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const w = new SigningWallet(TEST_MNEMONIC);

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:54329/trafx_test';
process.env.EVM_XPUB = w.accountXpub('evm');
process.env.TRON_XPUB = w.accountXpub('tron');
process.env.ETH_RPC_URL = 'http://127.0.0.1:1';
process.env.BSC_RPC_URL = 'http://127.0.0.1:1';
process.env.TRON_ENABLED = 'true';
process.env.TON_ENABLED = 'true';
process.env.TON_TREASURY_ADDRESS = WalletContractV4.create({ workchain: 0, publicKey: keyPairFromSeed(tonHotSeed(TEST_MNEMONIC)).publicKey }).address.toString({ bounceable: false });
process.env.PAYOUT_REQUIRE_APPROVAL = 'true';
process.env.DEFAULT_FEE_PERCENT = '1';
process.env.LOG_LEVEL = 'silent';

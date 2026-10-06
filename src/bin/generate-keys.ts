import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { keyPairFromSeed } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { HOT_ACCOUNT, SigningWallet, tonHotSeed } from '../wallet/hd.js';

// Usage: npm run keys:generate            -> new mnemonic
//        MNEMONIC="..." npm run keys:generate -> derive public data from an existing one
const mnemonic = process.env.MNEMONIC?.trim() || generateMnemonic(wordlist, 256);
if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid mnemonic');
const w = new SigningWallet(mnemonic);
const ton = WalletContractV4.create({ workchain: 0, publicKey: keyPairFromSeed(tonHotSeed(mnemonic)).publicKey });

console.log(`
=== SECRET — signer host only, back it up offline ===
SIGNER_MNEMONIC="${mnemonic}"

=== Public — API + worker hosts ===
EVM_XPUB=${w.accountXpub('evm')}
TRON_XPUB=${w.accountXpub('tron')}
TON_TREASURY_ADDRESS=${ton.address.toString({ bounceable: false })}

=== Hot wallets (fund with gas: ETH/BNB/POL, TRX, TON) ===
EVM hot wallet : ${w.privateKey('evm', 0, HOT_ACCOUNT).address}
TRON hot wallet: ${w.privateKey('tron', 0, HOT_ACCOUNT).address}
TON hot wallet : ${ton.address.toString({ bounceable: false })}
`);

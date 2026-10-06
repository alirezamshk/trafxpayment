import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createHmac } from 'node:crypto';
import { computeAddress, decodeBase58, encodeBase58, getAddress, getBytes, hexlify, sha256 } from 'ethers';

export type KeyFamily = 'evm' | 'tron';

/** BIP-44 coin types. */
export const COIN_TYPE: Record<KeyFamily, number> = { evm: 60, tron: 195 };

/** Account used for invoice deposit addresses. */
export const DEPOSIT_ACCOUNT = 0;
/** Account whose index 0 is the platform hot wallet: sweep destination, gas source and payout source. */
export const HOT_ACCOUNT = 1;

export function accountPath(family: KeyFamily, account: number): string {
  return `m/44'/${COIN_TYPE[family]}'/${account}'`;
}

// ---------------------------------------------------------------- TRON address helpers

export function tronAddressFromEvm(evmAddress: string): string {
  const payload = getBytes('0x41' + evmAddress.slice(2).toLowerCase());
  const checksum = getBytes(sha256(sha256(payload))).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return encodeBase58(full);
}

/** Base58 TRON address -> 41-prefixed hex (no 0x). Throws on a bad checksum. */
export function tronToHex(address: string): string {
  const hex = decodeBase58(address).toString(16).padStart(50, '0');
  const bytes = getBytes('0x' + hex);
  const payload = bytes.slice(0, 21);
  const checksum = hexlify(bytes.slice(21));
  const expected = hexlify(getBytes(sha256(sha256(payload))).slice(0, 4));
  if (checksum !== expected || payload[0] !== 0x41) throw new Error(`Invalid TRON address: ${address}`);
  return hexlify(payload).slice(2);
}

export function tronHexToBase58(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const body = h.length === 42 ? h.slice(2) : h; // strip 41 prefix if present
  return tronAddressFromEvm('0x' + body.padStart(40, '0'));
}

export function isValidTronAddress(address: string): boolean {
  try {
    tronToHex(address);
    return true;
  } catch {
    return false;
  }
}

function addressFromPublicKey(family: KeyFamily, publicKey: Uint8Array): string {
  const evm = computeAddress(hexlify(publicKey));
  return family === 'evm' ? getAddress(evm) : tronAddressFromEvm(evm);
}

// ---------------------------------------------------------------- watch-only derivation (xpub)

export class WatchOnlyWallet {
  private readonly account: HDKey;

  constructor(
    readonly family: KeyFamily,
    xpub: string,
  ) {
    this.account = HDKey.fromExtendedKey(xpub);
    if (this.account.privateKey) throw new Error(`${family} xpub must be a PUBLIC key; never configure an xprv here`);
  }

  /** Address at <account>/0/index (external chain). */
  deriveAddress(index: number): string {
    const child = this.account.deriveChild(0).deriveChild(index);
    if (!child.publicKey) throw new Error('Derivation failed');
    return addressFromPublicKey(this.family, child.publicKey);
  }
}

// ---------------------------------------------------------------- signing derivation (sweeper only)

export class SigningWallet {
  private readonly root: HDKey;

  constructor(mnemonic: string, passphrase = '') {
    this.root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic.trim(), passphrase));
  }

  accountXpub(family: KeyFamily, account = DEPOSIT_ACCOUNT): string {
    return this.root.derive(accountPath(family, account)).publicExtendedKey;
  }

  privateKey(family: KeyFamily, index: number, account = DEPOSIT_ACCOUNT): { privateKey: string; address: string } {
    const node = this.root.derive(`${accountPath(family, account)}/0/${index}`);
    if (!node.privateKey || !node.publicKey) throw new Error('Derivation failed');
    return { privateKey: hexlify(node.privateKey), address: addressFromPublicKey(family, node.publicKey) };
  }
}

// ---------------------------------------------------------------- TON (ed25519, SLIP-0010)

/** SLIP-0010 ed25519 derivation (hardened only). Returns the 32-byte seed for the key pair. */
export function slip10Ed25519(seed: Uint8Array, path: string): Buffer {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32);
  let chain = I.subarray(32);
  for (const part of path.split('/').slice(1)) {
    if (!part.endsWith("'")) throw new Error('ed25519 supports hardened derivation only');
    const index = (Number(part.slice(0, -1)) | 0x80000000) >>> 0;
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE(index, 33);
    I = createHmac('sha512', chain).update(data).digest();
    key = I.subarray(0, 32);
    chain = I.subarray(32);
  }
  return Buffer.from(key);
}

export const TON_HOT_PATH = "m/44'/607'/0'";

export function tonHotSeed(mnemonic: string, passphrase = ''): Buffer {
  return slip10Ed25519(mnemonicToSeedSync(mnemonic.trim(), passphrase), TON_HOT_PATH);
}

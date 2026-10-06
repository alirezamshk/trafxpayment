import { Address } from '@ton/core';
import { isAddress } from 'ethers';
import type { ChainFamily } from '../chains/assets.js';
import { isValidTronAddress } from '../wallet/hd.js';

export function isValidAddress(family: ChainFamily, address: string): boolean {
  switch (family) {
    case 'evm':
      return /^0x[0-9a-fA-F]{40}$/.test(address) && isAddress(address);
    case 'tron':
      return isValidTronAddress(address);
    case 'ton':
      try {
        Address.parse(address);
        return true;
      } catch {
        return false;
      }
  }
}

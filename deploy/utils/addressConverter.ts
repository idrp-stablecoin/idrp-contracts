/**
 * Convert TRON base58 address to EVM hex format
 * TRON addresses starting with 'T' are base58-encoded
 * For hardhat-deploy compatibility, we need to convert them to 0x... hex format
 */

// Simple base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode base58 string to bytes
 */
function base58Decode(str: string): Uint8Array {
  let decoded = 0n;
  let multiplyFactor = 1n;

  for (let i = str.length - 1; i >= 0; i--) {
    const digit = BASE58_ALPHABET.indexOf(str[i]);
    if (digit === -1) {
      throw new Error(`Invalid base58 character: ${str[i]}`);
    }
    decoded += BigInt(digit) * multiplyFactor;
    multiplyFactor *= 58n;
  }

  // Convert BigInt to bytes
  const bytes: number[] = [];
  if (decoded === 0n) {
    bytes.push(0);
  } else {
    let num = decoded;
    while (num > 0n) {
      bytes.unshift(Number(num & 0xffn));
      num >>= 8n;
    }
  }

  // Handle leading zeros
  for (let i = 0; i < str.length && str[i] === "1"; i++) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Convert TRON base58 address to EVM hex address
 * @param tronAddress TRON address in base58 format (e.g., "TDMSpjqbkLbZXtuQAJTAa4FDGUbGkjK1pv")
 * @returns EVM hex address (e.g., "0x...")
 */
export function tronToHex(tronAddress: string): string {
  if (!tronAddress.startsWith("T")) {
    throw new Error("Invalid TRON address: must start with T");
  }

  try {
    const decoded = base58Decode(tronAddress);
    
    // TRON address is 21 bytes: 1 byte version + 20 bytes address + 4 bytes checksum
    if (decoded.length !== 25) {
      throw new Error(`Invalid TRON address length: expected 25 bytes, got ${decoded.length}`);
    }

    // Extract the 20-byte address (skip version byte, exclude checksum)
    const addressBytes = decoded.slice(1, 21);
    
    // Convert to hex string
    const hexAddress = "0x" + Array.from(addressBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    
    return hexAddress;
  } catch (error) {
    throw new Error(`Failed to convert TRON address to hex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if address is a TRON base58 address
 */
export function isTronAddress(address: string): boolean {
  return typeof address === "string" && address.startsWith("T");
}

/**
 * Convert address to appropriate format based on network
 */
export function normalizeAddress(address: string, isTronNetwork: boolean): string {
  if (isTronNetwork && isTronAddress(address)) {
    return tronToHex(address);
  }
  return address;
}

export default {
  tronToHex,
  isTronAddress,
  normalizeAddress,
};

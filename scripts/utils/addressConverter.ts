/**
 * Convert TRON base58 address to EVM hex format
 * TRON addresses starting with 'T' are base58-encoded
 * For hardhat-deploy compatibility, we need to convert them to 0x... hex format
 */

// Simple base58 alphabet
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
      throw new Error(
        `Invalid TRON address length: expected 25 bytes, got ${decoded.length}`
      );
    }

    // Extract the 20-byte address (skip version byte, exclude checksum)
    const addressBytes = decoded.slice(1, 21);

    // Convert to hex string
    const hexAddress =
      "0x" +
      Array.from(addressBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return hexAddress;
  } catch (error) {
    throw new Error(
      `Failed to convert TRON address to hex: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Convert EVM hex address to TRON base58 address
 * @param address EVM hex address
 * @returns TRON address
 */
export function hexToTron(address: string): string {
  if (!address.startsWith("0x") || address.length !== 42) {
    throw new Error("Invalid EVM hex address");
  }

  // Remove '0x' prefix
  const hex = address.slice(2);

  // Convert hex to bytes
  const addressBytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    addressBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // Prepend version byte (0x41 for TRON mainnet)
  const versionedPayload = new Uint8Array(21);
  versionedPayload[0] = 0x41; // Version byte for TRON mainnet
  versionedPayload.set(addressBytes, 1);

  // Compute checksum (first 4 bytes of double SHA256)
  const crypto = require("crypto");
  const hash1 = crypto.createHash("sha256").update(versionedPayload).digest();
  const hash2 = crypto.createHash("sha256").update(hash1).digest();
  const checksum = hash2.slice(0, 4);

  // Concatenate versioned payload and checksum
  const fullPayload = new Uint8Array(25);
  fullPayload.set(versionedPayload, 0);
  fullPayload.set(checksum, 21);

  // Convert to base58
  let num = BigInt(0);
  for (let i = 0; i < fullPayload.length; i++) {
    num = (num << 8n) + BigInt(fullPayload[i]);
  }

  let base58 = "";
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    base58 = BASE58_ALPHABET[Number(remainder)] + base58;
  }

  // Handle leading zeros
  for (let i = 0; i < fullPayload.length && fullPayload[i] === 0; i++) {
    base58 = "1" + base58;
  }

  return base58;
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
export function normalizeAddress(
  address: string,
  isTronNetwork: boolean
): string {
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

const bs58check = require("bs58check").default;

function base58Tobase16(address) {
  if (!address) throw new Error("Invalid address");

  // Already hex (with or without 0x)
  if (address.startsWith("0x")) return address.slice(2);
  if (address.startsWith("41") && address.length === 42) return address;

  // Base58Check TRON address (starts with 'T')
  if (address[0] === "T") {
    const payload = bs58check.decode(address); // 0x41 + 20-byte address
    if (payload.length !== 21 || payload[0] !== 0x41) {
      throw new Error("Invalid TRON base58 address");
    }
    return Buffer.from(payload).toString("hex"); // "41" + 20-byte hex
  }

  throw new Error("Unsupported address format");
}

function tronAddressToEthFormatAddress(address) {
  const base16Address = base58Tobase16(address);
  return "0x" + base16Address.slice(2);
}

module.exports = {
  base58Tobase16,
  tronAddressToEthFormatAddress,
};

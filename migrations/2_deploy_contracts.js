const { deployProxy } = require("@openzeppelin/truffle-upgrades");
const bs58check = require("bs58check").default;

const IDRP = artifacts.require("IDRP");
const IDRPController = artifacts.require("IDRPController");

function base58ToHex(address) {
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

module.exports = async function (deployer, network, accounts) {
  try {
    deployer.trufflePlugin = true;
    const superAdmin = accounts;
    const superAdminHex = "0x" + base58ToHex(superAdmin).slice(2);
    console.log("[1_deploy_contracts] Deploying...", {
      superAdmin,
      superAdminHex,
    });

    const idrp = await deployProxy(IDRP, [superAdminHex], { deployer });
    console.log("[1_deploy_contracts] Deployed IDRP at", idrp.address);
    const idrpController = await deployProxy(
      IDRPController,
      [idrp.address, superAdminHex],
      { deployer }
    );
    console.log(
      "[1_deploy_contracts] Deployed IDRPController at",
      idrpController.address
    );
  } catch (error) {
    console.error("[1_deploy_contracts] deploy error", error);
  }
};

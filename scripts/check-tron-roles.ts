import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const networkName = (await import("hardhat")).default.network.name;
  const deploymentsPath = path.join(__dirname, "../deployments", networkName);

  const idrpJson = JSON.parse(fs.readFileSync(path.join(deploymentsPath, "IDRP.json"), "utf-8"));
  const proxyAddress = idrpJson.address;

  console.log("Network:", networkName);
  console.log("IDRP proxy:", proxyAddress);

  const idrp = await ethers.getContractAt("IDRP", proxyAddress);

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const MINTER_ROLE   = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const PAUSER_ROLE   = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const FREEZER_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("FREEZER_ROLE"));
  const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

  // Derive admin address from stored private key
  const { vars } = await import("hardhat/config");
  const pk = vars.get("IDRP_ADMIN_PRIVATE_KEY_TRON");
  const adminWallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const adminAddress = adminWallet.address;

  console.log("\nAdmin EVM address:", adminAddress);
  console.log("\n--- IDRP Roles ---");
  console.log("DEFAULT_ADMIN_ROLE:", await idrp.hasRole(DEFAULT_ADMIN_ROLE, adminAddress));
  console.log("MINTER_ROLE:       ", await idrp.hasRole(MINTER_ROLE, adminAddress));
  console.log("PAUSER_ROLE:       ", await idrp.hasRole(PAUSER_ROLE, adminAddress));
  console.log("FREEZER_ROLE:      ", await idrp.hasRole(FREEZER_ROLE, adminAddress));
  console.log("UPGRADER_ROLE:     ", await idrp.hasRole(UPGRADER_ROLE, adminAddress));
  console.log("\nDepository wallet:", await idrp.depositoryWallet());
  console.log("Max supply:        ", await idrp.maxSupply());
  console.log("Paused:            ", await idrp.paused());

  // Check if IDRPController is deployed
  const controllerFile = path.join(deploymentsPath, "IDRPController.json");
  if (fs.existsSync(controllerFile)) {
    const controllerJson = JSON.parse(fs.readFileSync(controllerFile, "utf-8"));
    const controllerAddress = controllerJson.address;
    console.log("\nIDRPController proxy:", controllerAddress);

    const controller = await ethers.getContractAt("IDRPController", controllerAddress);
    console.log("\n--- IDRPController Roles ---");
    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    console.log("DEFAULT_ADMIN_ROLE:", await controller.hasRole(DEFAULT_ADMIN_ROLE, adminAddress));
    console.log("ADMIN_ROLE:        ", await controller.hasRole(ADMIN_ROLE, adminAddress));
    console.log("owner():           ", await controller.owner());
    console.log("idrpToken():       ", await controller.idrpToken());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

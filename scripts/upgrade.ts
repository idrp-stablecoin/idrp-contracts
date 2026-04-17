import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Upgrade IDRP token contract
 *
 * IDRP uses onlyRole(UPGRADER_ROLE) — no timelock.
 * The caller (signers[1]) must hold UPGRADER_ROLE on the IDRP proxy.
 */
async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const admin = signers[1]; // must hold UPGRADER_ROLE
  console.log("Admin (upgrader):", admin.address);

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }

  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments["IDRP"];
  if (!proxyAddress) {
    throw new Error("IDRP proxy address not found in deployment file");
  }
  console.log("IDRP proxy:", proxyAddress);

  // Verify caller has UPGRADER_ROLE
  const idrp = await hre.ethers.getContractAt("IDRP", proxyAddress, admin);
  const UPGRADER_ROLE = await idrp.UPGRADER_ROLE();
  const hasRole = await idrp.hasRole(UPGRADER_ROLE, admin.address);
  if (!hasRole) {
    throw new Error(
      `Admin ${admin.address} does not have UPGRADER_ROLE on IDRP. Cannot upgrade.`
    );
  }

  console.log("Upgrading IDRP...");
  const IDRP = await hre.ethers.getContractFactory("IDRP", admin);
  const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, IDRP);
  await upgraded.waitForDeployment();

  console.log("IDRP upgraded successfully!");
  console.log("Proxy:", await upgraded.getAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

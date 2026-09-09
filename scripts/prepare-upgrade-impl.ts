import fs from "fs";
import path from "path";
import hre from "hardhat";
import { assertOz4TronOnly } from "./utils/assert-oz4-tron-only";

/**
 * Deploys ONLY a new IDRP implementation contract — does NOT call
 * scheduleUpgrade or upgradeToAndCall on the proxy. Use this when you want
 * to execute the upgrade manually (e.g. via Etherscan write tab).
 *
 * What it does:
 *   1. Validates the upgrade against OZ's storage layout (deployImplementation
 *      runs the same safety checks as upgradeProxy).
 *   2. Deploys a fresh implementation.
 *   3. Records the address in deployment/chain-{chainId}.json under
 *      "IDRPPreparedImpl" so it doesn't collide with the timelock script's
 *      "IDRPScheduledImpl" key.
 *
 * After running, call the proxy manually:
 *   - v1 → v2 migration (legacy UPGRADER_ROLE):
 *       upgradeToAndCall(newImpl, initializeV2Calldata)
 *     where initializeV2Calldata is the ABI-encoded call to
 *     initializeV2(_upgrader, legacyHolders).
 *   - v2 → v2+ (timelocked):
 *       scheduleUpgrade(newImpl), wait UPGRADE_DELAY, upgradeTo(newImpl).
 *       NOT upgradeToAndCall(newImpl, "0x") — on OZ 4.9.6 that passes
 *       forceCall=true and delegatecalls the impl with empty calldata, which
 *       reverts "Address: low-level delegate call failed".
 */
async function main() {
  await assertOz4TronOnly(hre);
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  console.log("Deployer:", deployer.address);

  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  let deployments: Record<string, string> = {};
  if (fs.existsSync(deploymentFile)) {
    deployments = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
  }

  const proxyAddress = deployments["IDRP"];
  if (!proxyAddress) {
    throw new Error("IDRP proxy address not found in deployment file");
  }
  console.log("IDRP proxy:", proxyAddress);

  const IDRP = await hre.ethers.getContractFactory("IDRP", deployer);

  console.log("\nDeploying new IDRP implementation...");
  const implAddress = (await hre.upgrades.deployImplementation(IDRP, {
    redeployImplementation: "always",
  })) as string;
  console.log("New implementation deployed:", implAddress);

  deployments["IDRPPreparedImpl"] = implAddress;
  deployments["IDRPPreparedImplDeployedAt"] = Math.floor(
    Date.now() / 1000
  ).toString();
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("Saved to:", deploymentFile);

  console.log("\n--- Next step (manual on Etherscan) ---");
  console.log(`Proxy:           ${proxyAddress}`);
  console.log(`New impl:        ${implAddress}`);
  console.log(
    `\nv1 → v2:  upgradeToAndCall(${implAddress}, <initializeV2 calldata>)`
  );
  console.log(
    `v2 → v2+: scheduleUpgrade(${implAddress}), wait UPGRADE_DELAY, then upgradeTo(${implAddress})`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

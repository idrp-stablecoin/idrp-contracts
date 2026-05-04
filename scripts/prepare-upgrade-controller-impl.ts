import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Deploys ONLY a new IDRPController implementation contract — does NOT call
 * scheduleUpgrade or upgradeToAndCall on the proxy. Use this when you want
 * to execute the upgrade manually (e.g. via Etherscan write tab).
 *
 * What it does:
 *   1. Validates the upgrade against OZ's storage layout. `unsafeAllow:
 *      ["missing-initializer-call"]` is required because v2 drops
 *      OwnableUpgradeable — the dropped storage is OZ-namespaced (ERC-7201)
 *      so it can't collide; see test/security-audit/V4-2-ControllerUpgraderPattern.ts.
 *   2. Deploys a fresh implementation.
 *   3. Records the address in deployment/chain-{chainId}.json under
 *      "IDRPControllerPreparedImpl" so it doesn't collide with the timelock
 *      script's "IDRPControllerScheduledImpl" key.
 *
 * After running, call the proxy manually:
 *   - v1 → v2 migration (legacy owner):
 *       upgradeToAndCall(newImpl, initializeV2Calldata)
 *     where initializeV2Calldata is the ABI-encoded call to initializeV2(_upgrader).
 *   - v2 → v2+ (timelocked):
 *       scheduleUpgrade(newImpl), wait UPGRADE_DELAY, upgradeToAndCall(newImpl, "0x").
 */
async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const deployer = signers[1];
  console.log("Deployer:", deployer.address);

  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  let deployments: Record<string, string> = {};
  if (fs.existsSync(deploymentFile)) {
    deployments = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
  }

  const proxyAddress = deployments["IDRPController"];
  if (!proxyAddress) {
    throw new Error(
      "IDRPController proxy address not found in deployment file"
    );
  }
  console.log("IDRPController proxy:", proxyAddress);

  const ControllerFactory = await hre.ethers.getContractFactory(
    "IDRPController",
    deployer
  );

  console.log("\nDeploying new IDRPController implementation...");
  const implAddress = (await hre.upgrades.deployImplementation(
    ControllerFactory,
    {
      redeployImplementation: "always",
      unsafeAllow: ["missing-initializer-call"],
    }
  )) as string;
  console.log("New implementation deployed:", implAddress);

  deployments["IDRPControllerPreparedImpl"] = implAddress;
  deployments["IDRPControllerPreparedImplDeployedAt"] = Math.floor(
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
    `v2 → v2+: scheduleUpgrade(${implAddress}), wait UPGRADE_DELAY, then upgradeToAndCall(${implAddress}, 0x)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Step 1 of 2: Schedule IDRP upgrade (v2 → v2+).
 *
 * This script:
 * 1. Deploys the new IDRP implementation contract.
 * 2. Calls scheduleUpgrade(newImpl) on the proxy (starts the 48h timelock).
 * 3. Saves the scheduled implementation + timestamp to deployment JSON.
 *
 * After this, wait 48h and run:
 *   npx hardhat run ./scripts/upgrade.ts --network <network>
 *
 * Note: this script is ONLY for v2+ upgrades. The v1 → v2 migration is instant
 * (authorized by legacy UPGRADER_ROLE) and runs directly through scripts/upgrade.ts.
 */
async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const admin = signers[1];
  console.log("Admin (upgrader):", admin.address);

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

  const idrp = await hre.ethers.getContractAt("IDRP", proxyAddress, admin);

  // Sanity: this is a v2+ proxy (has `upgrader`) and caller equals the upgrader.
  let currentUpgrader: string;
  try {
    currentUpgrader = await idrp.upgrader();
  } catch {
    throw new Error(
      `Proxy at ${proxyAddress} has no upgrader() — looks like a v1 proxy. ` +
        `Run scripts/upgrade.ts directly to perform the v1 → v2 migration.`
    );
  }
  if (currentUpgrader === hre.ethers.ZeroAddress) {
    throw new Error(
      `upgrader() is unset on ${proxyAddress}. Run scripts/upgrade.ts to migrate v1 → v2 first.`
    );
  }
  if (currentUpgrader.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(
      `Admin ${admin.address} is not the current upgrader (${currentUpgrader}).`
    );
  }

  // Abort if there's already a pending scheduled upgrade.
  const existingScheduled: string = await idrp.scheduledImplementation();
  if (existingScheduled !== hre.ethers.ZeroAddress) {
    const scheduledAt: bigint = await idrp.upgradeScheduledAt();
    const delay: bigint = await idrp.UPGRADE_DELAY();
    const executableAt = scheduledAt + delay;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const remaining = executableAt > now ? executableAt - now : 0n;
    const remainingHours = Number(remaining) / 3600;

    // Reconcile JSON to on-chain truth before bailing — a stale local file
    // gets corrected so subsequent scripts see accurate state.
    deployments["IDRPScheduledImpl"] = existingScheduled;
    deployments["IDRPScheduledAt"] = scheduledAt.toString();
    deployments["IDRPExecutableAfter"] = executableAt.toString();
    fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));

    console.log("\n--- Pending Upgrade Already Exists ---");
    console.log("Scheduled implementation:", existingScheduled);
    console.log(
      "Scheduled at:",
      new Date(Number(scheduledAt) * 1000).toISOString()
    );
    console.log(
      "Executable after:",
      new Date(Number(executableAt) * 1000).toISOString()
    );
    console.log(`Time remaining: ${remainingHours.toFixed(2)} hours`);
    console.log("(JSON reconciled to on-chain state.)");
    console.log("\nTo proceed, either:");
    console.log(
      `  1. Wait for timelock, then run: npx hardhat run ./scripts/upgrade.ts --network ${hre.network.name}`
    );
    console.log(
      `  2. Cancel with: npx hardhat run ./scripts/cancel-upgrade.ts --network ${hre.network.name}`
    );
    return;
  }

  console.log("\nDeploying new IDRP implementation...");
  const IDRP = await hre.ethers.getContractFactory("IDRP", admin);
  const implAddress = (await hre.upgrades.deployImplementation(IDRP, {
    redeployImplementation: "always",
  })) as string;
  console.log("New implementation deployed:", implAddress);

  console.log("\nScheduling upgrade...");
  const tx = await (idrp as any).scheduleUpgrade(implAddress);
  const receipt = await tx.wait();
  console.log("scheduleUpgrade tx:", receipt?.hash);

  const scheduledAt: bigint = await idrp.upgradeScheduledAt();
  const delay: bigint = await idrp.UPGRADE_DELAY();
  const executableAfter = scheduledAt + delay;
  const delayHours = Number(delay) / 3600;

  console.log("\n--- Upgrade Scheduled ---");
  console.log("Implementation:", implAddress);
  console.log(
    "Scheduled at:",
    new Date(Number(scheduledAt) * 1000).toISOString()
  );
  console.log(`Timelock: ${delayHours} hours`);
  console.log(
    "Executable after:",
    new Date(Number(executableAfter) * 1000).toISOString()
  );

  deployments["IDRPScheduledImpl"] = implAddress;
  deployments["IDRPScheduledAt"] = scheduledAt.toString();
  deployments["IDRPExecutableAfter"] = executableAfter.toString();
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("\nSaved to:", deploymentFile);

  console.log(`\nNext step: wait ${delayHours}h, then run:`);
  console.log(
    `  npx hardhat run ./scripts/upgrade.ts --network ${hre.network.name}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

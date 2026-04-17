import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Step 1 of 2: Schedule IDRPController upgrade
 *
 * This script:
 * 1. Deploys the new IDRPController implementation contract
 * 2. Calls scheduleUpgrade(newImpl) on the proxy (starts 48h timelock)
 * 3. Saves the scheduled implementation address + timestamp to deployment JSON
 *
 * After this, wait 48h then run: npx hardhat run ./scripts/upgrade-controller.ts --network <network>
 */
async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const admin = signers[1]; // owner of IDRPController
  console.log("Admin (owner):", admin.address);

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
    throw new Error("IDRPController proxy address not found in deployment file");
  }
  console.log("IDRPController proxy:", proxyAddress);

  // Check if there's already a pending scheduled upgrade
  const controller = await hre.ethers.getContractAt(
    "IDRPController",
    proxyAddress,
    admin
  );

  const existingScheduled = await controller.scheduledImplementation();
  if (existingScheduled !== hre.ethers.ZeroAddress) {
    const scheduledAt = await controller.upgradeScheduledAt();
    const delay = await controller.UPGRADE_DELAY();
    const executableAt = scheduledAt + delay;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const remainingSeconds = executableAt > now ? executableAt - now : 0n;
    const remainingHours = Number(remainingSeconds) / 3600;

    console.log("\n--- Pending Upgrade Already Exists ---");
    console.log("Scheduled implementation:", existingScheduled);
    console.log("Scheduled at:", new Date(Number(scheduledAt) * 1000).toISOString());
    console.log("Executable after:", new Date(Number(executableAt) * 1000).toISOString());
    console.log(`Time remaining: ${remainingHours.toFixed(2)} hours`);
    console.log("\nTo proceed, either:");
    console.log("  1. Wait for timelock and run: npx hardhat run ./scripts/upgrade-controller.ts --network", hre.network.name);
    console.log("  2. Cancel with: npx hardhat run ./scripts/cancel-upgrade-controller.ts --network", hre.network.name);
    return;
  }

  // Step 1: Deploy new implementation
  console.log("\nDeploying new IDRPController implementation...");
  const IDRPController = await hre.ethers.getContractFactory(
    "IDRPController",
    admin
  );
  const implAddress = await hre.upgrades.deployImplementation(IDRPController, {
    redeployImplementation: "always",
  });
  console.log("New implementation deployed:", implAddress);

  // Step 2: Schedule upgrade (starts 48h timelock)
  console.log("\nScheduling upgrade...");
  const tx = await controller.scheduleUpgrade(implAddress);
  const receipt = await tx.wait();
  console.log("scheduleUpgrade tx:", receipt?.hash);

  // Read on-chain state for confirmation
  const scheduledAt = await controller.upgradeScheduledAt();
  const delay = await controller.UPGRADE_DELAY();
  const executableAfter = scheduledAt + delay;
  const delayHours = Number(delay) / 3600;

  console.log("\n--- Upgrade Scheduled ---");
  console.log("Implementation:", implAddress);
  console.log("Scheduled at:", new Date(Number(scheduledAt) * 1000).toISOString());
  console.log(`Timelock: ${delayHours} hours`);
  console.log("Executable after:", new Date(Number(executableAfter) * 1000).toISOString());

  // Step 3: Save to deployment file
  deployments["IDRPControllerScheduledImpl"] = implAddress as string;
  deployments["IDRPControllerScheduledAt"] = scheduledAt.toString();
  deployments["IDRPControllerExecutableAfter"] = executableAfter.toString();
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("\nSaved to:", deploymentFile);

  console.log(`\nNext step: wait ${delayHours}h, then run:`);
  console.log(`  npx hardhat run ./scripts/upgrade-controller.ts --network ${hre.network.name}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

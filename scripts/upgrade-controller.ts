import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Step 2 of 2: Execute IDRPController upgrade (after timelock)
 *
 * Prerequisites:
 * 1. Run schedule-upgrade-controller.ts first
 * 2. Wait for 48h timelock to expire
 *
 * This script:
 * 1. Reads scheduled implementation from deployment JSON
 * 2. Verifies timelock has expired
 * 3. Calls upgradeProxy (which triggers _authorizeUpgrade with timelock check)
 * 4. Cleans up scheduled entries from deployment JSON
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

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }

  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments["IDRPController"];
  if (!proxyAddress) {
    throw new Error("IDRPController proxy address not found in deployment file");
  }

  // Check on-chain state (source of truth)
  const controller = await hre.ethers.getContractAt(
    "IDRPController",
    proxyAddress,
    admin
  );

  const scheduledImpl = await controller.scheduledImplementation();
  if (scheduledImpl === hre.ethers.ZeroAddress) {
    console.log("No upgrade scheduled on-chain.");
    console.log("Run schedule-upgrade-controller.ts first:");
    console.log(`  npx hardhat run ./scripts/schedule-upgrade-controller.ts --network ${hre.network.name}`);
    return;
  }

  const scheduledAt = await controller.upgradeScheduledAt();
  const delay = await controller.UPGRADE_DELAY();
  const executableAfter = scheduledAt + delay;
  const now = BigInt(Math.floor(Date.now() / 1000));

  console.log("\n--- Scheduled Upgrade ---");
  console.log("Proxy:", proxyAddress);
  console.log("Scheduled implementation:", scheduledImpl);
  console.log("Scheduled at:", new Date(Number(scheduledAt) * 1000).toISOString());
  console.log("Executable after:", new Date(Number(executableAfter) * 1000).toISOString());
  console.log("Current time:", new Date(Number(now) * 1000).toISOString());

  if (now < executableAfter) {
    const remainingSeconds = Number(executableAfter - now);
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    console.log(`\nTimelock not expired. Remaining: ${hours}h ${minutes}m`);
    console.log("Try again after:", new Date(Number(executableAfter) * 1000).toISOString());
    return;
  }

  console.log("\nTimelock expired. Executing upgrade...");

  // Cross-check with deployment file if available
  const savedImpl = deployments["IDRPControllerScheduledImpl"];
  if (savedImpl && savedImpl.toLowerCase() !== scheduledImpl.toLowerCase()) {
    console.warn(
      `WARNING: deployment file has ${savedImpl} but on-chain has ${scheduledImpl}`
    );
    console.warn("Using on-chain value (source of truth).");
  }

  // Execute upgrade
  const IDRPController = await hre.ethers.getContractFactory(
    "IDRPController",
    admin
  );
  const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, IDRPController, {
    redeployImplementation: "never",
  });
  await upgraded.waitForDeployment();

  console.log("\nIDRPController upgraded successfully!");
  console.log("Proxy:", await upgraded.getAddress());

  // Verify on-chain state is cleared
  const newScheduled = await controller.scheduledImplementation();
  console.log("scheduledImplementation (should be 0x0):", newScheduled);

  // Clean up deployment file
  delete deployments["IDRPControllerScheduledImpl"];
  delete deployments["IDRPControllerScheduledAt"];
  delete deployments["IDRPControllerExecutableAfter"];
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("Cleaned up scheduled entries from deployment file.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

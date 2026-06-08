import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Cancel a scheduled IDRPController upgrade
 *
 * Use this if you need to abort a scheduled upgrade before the timelock expires.
 */
async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const admin = signers[1];
  console.log("Admin (owner):", admin.address);

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments["IDRPController"];
  const controller = await hre.ethers.getContractAt(
    "IDRPController",
    proxyAddress,
    admin
  );

  const scheduledImpl = await controller.scheduledImplementation();
  if (scheduledImpl === hre.ethers.ZeroAddress) {
    console.log("No upgrade scheduled on-chain. Nothing to cancel.");
    // Still reconcile JSON: clear stale schedule entries.
    const hadStale =
      deployments["IDRPControllerScheduledImpl"] ||
      deployments["IDRPControllerScheduledAt"] ||
      deployments["IDRPControllerExecutableAfter"];
    if (hadStale) {
      delete deployments["IDRPControllerScheduledImpl"];
      delete deployments["IDRPControllerScheduledAt"];
      delete deployments["IDRPControllerExecutableAfter"];
      fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
      console.log("(Cleared stale schedule entries from deployment file.)");
    }
    return;
  }

  console.log("Cancelling scheduled upgrade:", scheduledImpl);
  const tx = await controller.cancelUpgrade();
  await tx.wait();
  console.log("Upgrade cancelled. tx:", tx.hash);

  // Clean up deployment file
  delete deployments["IDRPControllerScheduledImpl"];
  delete deployments["IDRPControllerScheduledAt"];
  delete deployments["IDRPControllerExecutableAfter"];
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("Cleaned up deployment file.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

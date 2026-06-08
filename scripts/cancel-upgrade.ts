import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Cancel a scheduled IDRP upgrade.
 *
 * Use this if you need to abort a scheduled upgrade before the timelock expires
 * — e.g. a newly discovered issue in the pending implementation.
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

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments["IDRP"];
  if (!proxyAddress) {
    throw new Error("IDRP proxy address not found in deployment file");
  }

  const idrp = await hre.ethers.getContractAt("IDRP", proxyAddress, admin);

  const scheduledImpl: string = await idrp.scheduledImplementation();
  if (scheduledImpl === hre.ethers.ZeroAddress) {
    console.log("No upgrade scheduled on-chain. Nothing to cancel.");
    // Still reconcile JSON: clear any stale schedule entries so the local
    // file stops misrepresenting state.
    const hadStale =
      deployments["IDRPScheduledImpl"] ||
      deployments["IDRPScheduledAt"] ||
      deployments["IDRPExecutableAfter"];
    if (hadStale) {
      delete deployments["IDRPScheduledImpl"];
      delete deployments["IDRPScheduledAt"];
      delete deployments["IDRPExecutableAfter"];
      fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
      console.log("(Cleared stale schedule entries from deployment file.)");
    }
    return;
  }

  console.log("Cancelling scheduled upgrade:", scheduledImpl);
  const tx = await (idrp as any).cancelUpgrade();
  await tx.wait();
  console.log("Upgrade cancelled. tx:", tx.hash);

  delete deployments["IDRPScheduledImpl"];
  delete deployments["IDRPScheduledAt"];
  delete deployments["IDRPExecutableAfter"];
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("Cleaned up deployment file.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

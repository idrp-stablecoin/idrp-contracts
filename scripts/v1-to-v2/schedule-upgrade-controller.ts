import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/v1-to-v2/schedule-upgrade-controller.ts
 *
 * For testnets whose deployed v1.5 Controller has an on-chain 48h timelock
 * baked into bytecode (e.g. Base Sepolia). Schedule the implementation
 * swap via the v1.5 contract's own `scheduleUpgrade` (onlyOwner). After
 * the timelock elapses, `scripts/v1-to-v2/upgrade-controller.ts` can
 * execute it.
 *
 * Run prepare-upgrade-controller.ts first so the prepared impl exists.
 *
 * Usage:
 *   npx hardhat run scripts/v1-to-v2/schedule-upgrade-controller.ts --network <testnet>
 */

async function main() {
  const networkId = hre.network.config.chainId ?? 0;
  console.log(`Network: ${hre.network.name} (chainId ${networkId})\n`);

  const deploymentFile = path.join(
    hre.config.paths.root,
    "deployment",
    `chain-${networkId}.json`
  );
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments.IDRPController;
  const preparedImpl = deployments.IDRPControllerv2PreparedImpl;
  if (!proxyAddress) throw new Error("deployments.IDRPController not set.");
  if (!preparedImpl) {
    throw new Error(
      `deployments.IDRPControllerv2PreparedImpl not set. Run prepare-upgrade-controller.ts first.`
    );
  }

  const signers = await hre.ethers.getSigners();
  const admin = signers[1];
  console.log(`Admin (must equal v1.5 owner): ${admin.address}`);
  console.log(`Proxy:                          ${proxyAddress}`);
  console.log(`Prepared v2 impl:               ${preparedImpl}\n`);

  // Pre-condition: admin must equal v1.5's owner().
  const ctrl = new hre.ethers.Contract(
    proxyAddress,
    [
      "function owner() view returns (address)",
      "function scheduleUpgrade(address newImplementation) external",
      "function scheduledImplementation() view returns (address)",
      "function upgradeScheduledAt() view returns (uint256)",
      "function UPGRADE_DELAY() view returns (uint256)",
    ],
    admin
  );

  const currentOwner = (await ctrl.owner()) as string;
  if (currentOwner.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(
      `Admin ${admin.address} does not match Controller owner ${currentOwner}.`
    );
  }

  console.log(`Calling scheduleUpgrade(${preparedImpl}) …`);
  const tx = await ctrl.scheduleUpgrade(preparedImpl);
  console.log(`  tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block: ${receipt!.blockNumber}`);

  const scheduledImpl = await ctrl.scheduledImplementation();
  const scheduledAt = await ctrl.upgradeScheduledAt();
  const delay = await ctrl.UPGRADE_DELAY();
  const execAfter = scheduledAt + delay;

  console.log(`\n✓ Scheduled.`);
  console.log(`  scheduledImplementation: ${scheduledImpl}`);
  console.log(`  upgradeScheduledAt:      ${scheduledAt} (unix)`);
  console.log(`  UPGRADE_DELAY (chain):   ${delay} seconds`);
  console.log(`  executableAfter:         ${execAfter} (unix)`);
  console.log(
    `  human time:              ${new Date(Number(execAfter) * 1000).toISOString()}`
  );

  deployments.IDRPControllerv2ScheduledAt = String(scheduledAt);
  deployments.IDRPControllerv2ExecutableAfter = String(execAfter);
  deployments.IDRPControllerv2ScheduleTxHash = tx.hash;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(`\nRecorded in deployment/chain-${networkId}.json.`);
  console.log(
    `\nNext: after ${new Date(Number(execAfter) * 1000).toISOString()}, run:\n` +
      `  npx hardhat run scripts/v1-to-v2/upgrade-controller.ts --network ${hre.network.name}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/schedule-upgrade-v3-controller.ts
 *
 * v2 → v3 Controller migration, step 1 of 2: deploy v3 impl + scheduleUpgrade.
 * After timelock, run upgrade-v3-controller.ts to execute atomically with
 * initializeV3.
 *
 * Caller must equal the current `upgrader()` on the Controller proxy.
 *
 * Usage:
 *   npx hardhat run scripts/schedule-upgrade-v3-controller.ts --network <name>
 */

async function main() {
  const networkId = hre.network.config.chainId ?? 0;
  console.log(`Network: ${hre.network.name} (chainId ${networkId})\n`);

  const deploymentDir = path.join(hre.config.paths.root, "deployment");
  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  const deployments: Record<string, string> = fs.existsSync(deploymentFile)
    ? JSON.parse(fs.readFileSync(deploymentFile, "utf-8"))
    : {};

  const proxyAddress = deployments.IDRPController;
  if (!proxyAddress) throw new Error("deployments.IDRPController not set.");
  console.log(`Controller proxy: ${proxyAddress}`);

  const signers = await hre.ethers.getSigners();

  const ctrlRO = new hre.ethers.Contract(
    proxyAddress,
    [
      "function upgrader() view returns (address)",
      "function scheduledImplementation() view returns (address)",
      "function upgradeScheduledAt() view returns (uint256)",
      "function UPGRADE_DELAY() view returns (uint256)",
    ],
    hre.ethers.provider
  );
  const currentUpgrader = (await ctrlRO.upgrader()) as string;
  const matching = signers.find(
    (s) => s.address.toLowerCase() === currentUpgrader.toLowerCase()
  );
  if (!matching) {
    throw new Error(
      `Current upgrader is ${currentUpgrader}. None of the configured signers match: ` +
        signers.map((s) => s.address).join(", ")
    );
  }
  const admin = matching;
  console.log(`Upgrader: ${admin.address}\n`);

  const ctrl = new hre.ethers.Contract(
    proxyAddress,
    [
      "function upgrader() view returns (address)",
      "function scheduleUpgrade(address newImplementation) external",
      "function scheduledImplementation() view returns (address)",
      "function upgradeScheduledAt() view returns (uint256)",
      "function UPGRADE_DELAY() view returns (uint256)",
    ],
    admin
  );

  const existingScheduled = (await ctrl.scheduledImplementation()) as string;
  if (existingScheduled !== hre.ethers.ZeroAddress) {
    throw new Error(
      `Already a pending scheduled upgrade: ${existingScheduled}.`
    );
  }

  console.log(`Force-importing proxy against IDRPControllerv2 layout …`);
  const V2 = await hre.ethers.getContractFactory("IDRPControllerv2");
  await hre.upgrades.forceImport(proxyAddress, V2, { kind: "uups" });

  console.log(`Validating v2 → v3 Controller upgrade safety …`);
  const V3 = await hre.ethers.getContractFactory("IDRPController");
  await hre.upgrades.validateUpgrade(proxyAddress, V3, {
    kind: "uups",
    unsafeAllow: ["missing-initializer-call"],
  });
  console.log(`  ✓ validateUpgrade passed`);

  console.log(`Deploying v3 IDRPController implementation …`);
  const newImpl = (await hre.upgrades.prepareUpgrade(proxyAddress, V3, {
    kind: "uups",
    unsafeAllow: ["missing-initializer-call"],
  })) as string;
  console.log(`  ✓ v3 impl: ${newImpl}`);

  console.log(`\nCalling scheduleUpgrade(${newImpl}) …`);
  const tx = await ctrl.scheduleUpgrade(newImpl);
  console.log(`  tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block: ${receipt!.blockNumber}`);

  const scheduledImpl = (await ctrl.scheduledImplementation()) as string;
  const scheduledAt = (await ctrl.upgradeScheduledAt()) as bigint;
  const delay = (await ctrl.UPGRADE_DELAY()) as bigint;
  const execAfter = scheduledAt + delay;

  console.log(`\n✓ Scheduled.`);
  console.log(`  scheduledImplementation: ${scheduledImpl}`);
  console.log(`  upgradeScheduledAt:      ${scheduledAt}`);
  console.log(`  UPGRADE_DELAY:           ${delay} seconds`);
  console.log(`  executableAfter (unix):  ${execAfter}`);
  console.log(
    `  human time:              ${new Date(Number(execAfter) * 1000).toISOString()}`
  );

  deployments.IDRPControllerv3ScheduledImpl = newImpl;
  deployments.IDRPControllerv3ScheduledAt = String(scheduledAt);
  deployments.IDRPControllerv3ExecutableAfter = String(execAfter);
  deployments.IDRPControllerv3ScheduleTxHash = tx.hash;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));

  console.log(`\nRecorded in deployment/chain-${networkId}.json.`);
  console.log(
    `\nNext: after the timelock, run:\n` +
      `  npx hardhat run scripts/upgrade-v3-controller.ts --network ${hre.network.name}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

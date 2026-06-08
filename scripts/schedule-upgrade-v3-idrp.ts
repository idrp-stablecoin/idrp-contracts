import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/schedule-upgrade-v3-idrp.ts
 *
 * v2 → v3 IDRP migration, step 1 of 2: deploy v3 impl + scheduleUpgrade
 * on the live v2 proxy. After this, wait UPGRADE_DELAY then run
 * scripts/upgrade-v3-idrp.ts to execute atomically with initializeV3.
 *
 * Caller must equal the current `upgrader()` on the IDRP proxy.
 *
 * Usage:
 *   npx hardhat run scripts/schedule-upgrade-v3-idrp.ts --network <name>
 */

async function main() {
  const networkId = hre.network.config.chainId ?? 0;
  console.log(`Network: ${hre.network.name} (chainId ${networkId})\n`);

  const deploymentDir = path.join(hre.config.paths.root, "deployment");
  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  const deployments: Record<string, string> = fs.existsSync(deploymentFile)
    ? JSON.parse(fs.readFileSync(deploymentFile, "utf-8"))
    : {};

  const proxyAddress = deployments.IDRP;
  if (!proxyAddress) throw new Error("deployments.IDRP not set.");
  console.log(`IDRP proxy: ${proxyAddress}`);

  const signers = await hre.ethers.getSigners();

  // First read the current upgrader without signing, then pick whichever local
  // signer matches it. On Kairos/mainnets the upgrader is the Safe (signers[1]);
  // on Base Sepolia it's the deployer (signers[0]).
  const idrpReadOnly = new hre.ethers.Contract(
    proxyAddress,
    [
      "function upgrader() view returns (address)",
      "function scheduledImplementation() view returns (address)",
      "function upgradeScheduledAt() view returns (uint256)",
      "function UPGRADE_DELAY() view returns (uint256)",
    ],
    hre.ethers.provider
  );
  const currentUpgrader = (await idrpReadOnly.upgrader()) as string;
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

  const idrp = new hre.ethers.Contract(
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

  const existingScheduled = (await idrp.scheduledImplementation()) as string;
  if (existingScheduled !== hre.ethers.ZeroAddress) {
    // On-chain has a pending schedule. Sync the JSON to reflect the truth so
    // a stale local file gets corrected, then bail. The cancel script can
    // then read accurate state.
    const existingAt = (await idrp.upgradeScheduledAt()) as bigint;
    const existingDelay = (await idrp.UPGRADE_DELAY()) as bigint;
    deployments.IDRPv3ScheduledImpl = existingScheduled;
    deployments.IDRPv3ScheduledAt = String(existingAt);
    deployments.IDRPv3ExecutableAfter = String(existingAt + existingDelay);
    fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
    throw new Error(
      `Already a pending scheduled upgrade on-chain: ${existingScheduled}. ` +
        `(JSON reconciled to match.) Cancel it before scheduling a new one.`
    );
  }

  console.log(`Force-importing proxy against IDRPv2 layout …`);
  const IDRPv2Factory = await hre.ethers.getContractFactory("IDRPv2");
  await hre.upgrades.forceImport(proxyAddress, IDRPv2Factory, { kind: "uups" });

  console.log(`Validating v2 → v3 upgrade safety …`);
  const IDRPv3Factory = await hre.ethers.getContractFactory("IDRP");
  await hre.upgrades.validateUpgrade(proxyAddress, IDRPv3Factory, {
    kind: "uups",
    unsafeAllow: ["missing-initializer-call"],
  });
  console.log(`  ✓ validateUpgrade passed`);

  console.log(`Deploying v3 IDRP implementation …`);
  const newImpl = (await hre.upgrades.prepareUpgrade(
    proxyAddress,
    IDRPv3Factory,
    { kind: "uups", unsafeAllow: ["missing-initializer-call"] }
  )) as string;
  console.log(`  ✓ v3 impl: ${newImpl}`);

  console.log(`\nCalling scheduleUpgrade(${newImpl}) …`);
  const tx = await idrp.scheduleUpgrade(newImpl);
  console.log(`  tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block: ${receipt!.blockNumber}`);

  const scheduledImpl = (await idrp.scheduledImplementation()) as string;
  const scheduledAt = (await idrp.upgradeScheduledAt()) as bigint;
  const delay = (await idrp.UPGRADE_DELAY()) as bigint;
  const execAfter = scheduledAt + delay;
  console.log(`\n✓ Scheduled.`);
  console.log(`  scheduledImplementation: ${scheduledImpl}`);
  console.log(`  upgradeScheduledAt:      ${scheduledAt}`);
  console.log(`  UPGRADE_DELAY:           ${delay} seconds`);
  console.log(`  executableAfter (unix):  ${execAfter}`);
  console.log(
    `  human time:              ${new Date(Number(execAfter) * 1000).toISOString()}`
  );

  deployments.IDRPv3ScheduledImpl = newImpl;
  deployments.IDRPv3ScheduledAt = String(scheduledAt);
  deployments.IDRPv3ExecutableAfter = String(execAfter);
  deployments.IDRPv3ScheduleTxHash = tx.hash;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));

  console.log(`\nRecorded in deployment/chain-${networkId}.json.`);
  console.log(
    `\nNext: after the timelock, run:\n` +
      `  npx hardhat run scripts/upgrade-v3-idrp.ts --network ${hre.network.name}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

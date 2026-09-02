import fs from "fs";
import path from "path";
import hre from "hardhat";
import { assertOz4TronOnly } from "./utils/assert-oz4-tron-only";

/**
 * scripts/upgrade-v3-idrp.ts
 *
 * v2 → v3 IDRP migration, step 2 of 2: after the timelock elapses, execute
 * upgradeToAndCall(scheduledImpl, initializeV3(admin, controller, upgrader))
 * atomically. Reads the scheduled impl from on-chain (source of truth), not
 * from the local deployment file.
 *
 * initializeV3 arguments:
 *   _admin       — the new admin slot. Default: same as current upgrader (Safe).
 *   _controller  — the IDRPController proxy address on this chain.
 *   _upgrader    — kept the same as the current upgrader.
 *
 * Override any of these via env vars: IDRP_V3_ADMIN, IDRP_V3_CONTROLLER, IDRP_V3_UPGRADER.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-v3-idrp.ts --network <name>
 */

async function main() {
  await assertOz4TronOnly(hre);
  const networkId = hre.network.config.chainId ?? 0;
  console.log(`Network: ${hre.network.name} (chainId ${networkId})\n`);

  const deploymentDir = path.join(hre.config.paths.root, "deployment");
  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  if (!fs.existsSync(deploymentFile))
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments.IDRP;
  const controllerAddr = deployments.IDRPController;
  if (!proxyAddress) throw new Error("deployments.IDRP not set.");
  if (!controllerAddr)
    throw new Error("deployments.IDRPController not set (needed for initializeV3).");

  const signers = await hre.ethers.getSigners();

  const idrpRO = new hre.ethers.Contract(
    proxyAddress,
    [
      "function upgrader() view returns (address)",
      "function scheduledImplementation() view returns (address)",
      "function upgradeScheduledAt() view returns (uint256)",
      "function UPGRADE_DELAY() view returns (uint256)",
    ],
    hre.ethers.provider
  );
  const currentUpgrader = (await idrpRO.upgrader()) as string;
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
  console.log(`Upgrader:                ${admin.address}`);
  console.log(`IDRP proxy:              ${proxyAddress}`);
  console.log(`Controller (for initV3): ${controllerAddr}\n`);

  const idrp = new hre.ethers.Contract(
    proxyAddress,
    [
      "function upgrader() view returns (address)",
      "function scheduledImplementation() view returns (address)",
      "function upgradeScheduledAt() view returns (uint256)",
      "function UPGRADE_DELAY() view returns (uint256)",
      "function upgradeToAndCall(address newImplementation, bytes data) external payable",
    ],
    admin
  );

  const scheduledImpl = (await idrp.scheduledImplementation()) as string;
  if (scheduledImpl === hre.ethers.ZeroAddress) {
    throw new Error("No scheduled implementation. Run scripts/schedule-upgrade-v3-idrp.ts first.");
  }
  const scheduledAt = (await idrp.upgradeScheduledAt()) as bigint;
  const delay = (await idrp.UPGRADE_DELAY()) as bigint;
  const execAfter = Number(scheduledAt + delay);
  const now = Math.floor(Date.now() / 1000);
  const remaining = execAfter - now;
  console.log(`Scheduled impl:          ${scheduledImpl}`);
  console.log(`Scheduled at (unix):     ${scheduledAt}`);
  console.log(`UPGRADE_DELAY (seconds): ${delay}`);
  console.log(`Executable after (unix): ${execAfter}`);
  if (remaining > 0) {
    throw new Error(
      `Timelock not yet expired. Wait ${remaining} more seconds ` +
        `(executable at ${new Date(execAfter * 1000).toISOString()}).`
    );
  }
  console.log(`Timelock expired ${-remaining}s ago — proceeding.\n`);

  // initializeV3 args
  const newAdmin = process.env.IDRP_V3_ADMIN ?? currentUpgrader;
  const newController = process.env.IDRP_V3_CONTROLLER ?? controllerAddr;
  const newUpgrader = process.env.IDRP_V3_UPGRADER ?? currentUpgrader;
  console.log(`initializeV3 args:`);
  console.log(`  _admin:      ${newAdmin}`);
  console.log(`  _controller: ${newController}`);
  console.log(`  _upgrader:   ${newUpgrader}\n`);

  const IDRPv3Iface = (await hre.ethers.getContractFactory("IDRP")).interface;
  const initData = IDRPv3Iface.encodeFunctionData("initializeV3", [
    newAdmin,
    newController,
    newUpgrader,
  ]);

  console.log(`Calling upgradeToAndCall(${scheduledImpl}, initializeV3(...)) …`);
  const tx = await idrp.upgradeToAndCall(scheduledImpl, initData);
  console.log(`  tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block: ${receipt!.blockNumber}\n`);

  // Post-migration probes
  const v3 = new hre.ethers.Contract(
    proxyAddress,
    [
      "function admin() view returns (address)",
      "function controller() view returns (address)",
      "function upgrader() view returns (address)",
      "function scheduledImplementation() view returns (address)",
    ],
    admin
  );
  const adminAfter = await v3.admin();
  const controllerAfter = await v3.controller();
  const upgraderAfter = await v3.upgrader();
  const scheduledAfter = await v3.scheduledImplementation();
  console.log(`✓ Upgrade executed.`);
  console.log(`  admin():                 ${adminAfter}`);
  console.log(`  controller():            ${controllerAfter}`);
  console.log(`  upgrader():              ${upgraderAfter}`);
  console.log(`  scheduledImplementation:${scheduledAfter} (should be 0x0)`);

  // Clean up the schedule fields
  delete deployments.IDRPv3ScheduledImpl;
  delete deployments.IDRPv3ScheduledAt;
  delete deployments.IDRPv3ExecutableAfter;
  deployments.IDRPv3ExecuteTxHash = tx.hash;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(`\nRecorded execute tx in deployment/chain-${networkId}.json.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

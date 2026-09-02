import fs from "fs";
import path from "path";
import hre from "hardhat";
import { assertOz4TronOnly } from "./utils/assert-oz4-tron-only";

/**
 * scripts/upgrade-v3-controller.ts
 *
 * v2 → v3 Controller migration, step 2 of 2: after timelock, execute
 * upgradeToAndCall(scheduledImpl, initializeV3(admin, upgrader, legacyDARHolders)).
 *
 * initializeV3 args:
 *   _admin                       — ACDAR DEFAULT_ADMIN_ROLE. Default: current upgrader (Safe).
 *   _upgrader                    — kept the same as current upgrader.
 *   _legacyDefaultAdminHolders   — read from deployment/chain-{id}-legacy-default-admin-holders.json
 *                                  (produced by scripts/list-default-admin-holders.ts OR by
 *                                  hand for chains where event-replay is unreliable).
 *
 * Override via env vars: CTRL_V3_ADMIN, CTRL_V3_UPGRADER.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-v3-controller.ts --network <name>
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

  const proxyAddress = deployments.IDRPController;
  if (!proxyAddress) throw new Error("deployments.IDRPController not set.");

  const legacyHoldersFile = path.join(
    deploymentDir,
    `chain-${networkId}-legacy-default-admin-holders.json`
  );
  if (!fs.existsSync(legacyHoldersFile)) {
    throw new Error(
      `Legacy DEFAULT_ADMIN_ROLE holders file missing: ${legacyHoldersFile}\n` +
        `Run scripts/list-default-admin-holders.ts --network ${hre.network.name} ` +
        `(or for chains with RPC limits, populate it by hand from hasRole probes).`
    );
  }
  const legacyHolders: string[] = JSON.parse(
    fs.readFileSync(legacyHoldersFile, "utf-8")
  );

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
  console.log(`Upgrader:                     ${admin.address}`);
  console.log(`Controller proxy:              ${proxyAddress}`);
  console.log(`Legacy DAR holders to revoke: ${legacyHolders.length}`);
  legacyHolders.forEach((h) => console.log(`  - ${h}`));
  console.log("");

  const ctrl = new hre.ethers.Contract(
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

  const scheduledImpl = (await ctrl.scheduledImplementation()) as string;
  if (scheduledImpl === hre.ethers.ZeroAddress) {
    throw new Error(
      "No scheduled implementation. Run scripts/schedule-upgrade-v3-controller.ts first."
    );
  }
  const scheduledAt = (await ctrl.upgradeScheduledAt()) as bigint;
  const delay = (await ctrl.UPGRADE_DELAY()) as bigint;
  const execAfter = Number(scheduledAt + delay);
  const now = Math.floor(Date.now() / 1000);
  const remaining = execAfter - now;
  console.log(`Scheduled impl:          ${scheduledImpl}`);
  console.log(`Executable after (unix): ${execAfter}`);
  if (remaining > 0) {
    throw new Error(
      `Timelock not yet expired. Wait ${remaining}s ` +
        `(executable ${new Date(execAfter * 1000).toISOString()}).`
    );
  }
  console.log(`Timelock expired ${-remaining}s ago — proceeding.\n`);

  const newAdmin = process.env.CTRL_V3_ADMIN ?? currentUpgrader;
  const newUpgrader = process.env.CTRL_V3_UPGRADER ?? currentUpgrader;
  console.log(`initializeV3 args:`);
  console.log(`  _admin:                     ${newAdmin}`);
  console.log(`  _upgrader:                  ${newUpgrader}`);
  console.log(`  _legacyDefaultAdminHolders: [${legacyHolders.length} addrs]\n`);

  const V3Iface = (await hre.ethers.getContractFactory("IDRPController"))
    .interface;
  const initData = V3Iface.encodeFunctionData("initializeV3", [
    newAdmin,
    newUpgrader,
    legacyHolders,
  ]);

  console.log(
    `Calling upgradeToAndCall(${scheduledImpl}, initializeV3(...)) …`
  );
  const tx = await ctrl.upgradeToAndCall(scheduledImpl, initData);
  console.log(`  tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block: ${receipt!.blockNumber}\n`);

  // Post-migration probes
  const v3 = new hre.ethers.Contract(
    proxyAddress,
    [
      "function defaultAdmin() view returns (address)",
      "function upgrader() view returns (address)",
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function scheduledImplementation() view returns (address)",
    ],
    admin
  );
  const adminAfter = await v3.defaultAdmin();
  const upgraderAfter = await v3.upgrader();
  const scheduledAfter = await v3.scheduledImplementation();
  const DAR =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  console.log(`✓ Upgrade executed.`);
  console.log(`  defaultAdmin():           ${adminAfter}`);
  console.log(`  upgrader():               ${upgraderAfter}`);
  console.log(`  scheduledImplementation: ${scheduledAfter} (should be 0x0)`);

  console.log(`\nVerifying DEFAULT_ADMIN_ROLE holder set:`);
  for (const h of legacyHolders) {
    const still = await v3.hasRole(DAR, h);
    const isAdmin = h.toLowerCase() === newAdmin.toLowerCase();
    const expected = isAdmin ? "true" : "false";
    const ok = still.toString() === expected;
    console.log(
      `  hasRole(DAR, ${h}) = ${still} ${ok ? "✓" : "✗ unexpected"} (expected ${expected})`
    );
  }

  delete deployments.IDRPControllerv3ScheduledImpl;
  delete deployments.IDRPControllerv3ScheduledAt;
  delete deployments.IDRPControllerv3ExecutableAfter;
  deployments.IDRPControllerv3ExecuteTxHash = tx.hash;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(`\nRecorded execute tx in deployment/chain-${networkId}.json.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

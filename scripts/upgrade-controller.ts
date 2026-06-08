import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * IDRPController upgrade executor.
 *
 * Two modes, auto-detected from proxy state:
 *
 * 1) v1 → v2 migration (instant, authorized by legacy `owner`):
 *    - Triggered when `upgrader()` is missing/zero — v1 proxies (which inherited
 *      OwnableUpgradeable) don't have the `upgrader` slot populated.
 *    - Caller must currently equal v1's `owner()` (v1's `_authorizeUpgrade`
 *      is `onlyOwner`).
 *    - Executes upgradeProxy with an atomic `initializeV2(_upgrader)` call so
 *      the implementation swap and single-upgrader wiring happen in one tx —
 *      no window where the proxy is on v2 with an unset upgrader.
 *
 * 2) v2 → v3+ (timelocked):
 *    - Caller must equal `upgrader()` (typically the Safe).
 *    - Must be preceded by scripts/schedule-upgrade-controller.ts + 48h wait.
 *    - This script verifies the schedule and executes.
 */
async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const signers = await hre.ethers.getSigners();
  const admin = signers[1];
  console.log("Admin:", admin.address);

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
  console.log("IDRPController proxy:", proxyAddress);

  const controller = await hre.ethers.getContractAt(
    "IDRPController",
    proxyAddress,
    admin
  );
  const ControllerFactory = await hre.ethers.getContractFactory(
    "IDRPController",
    admin
  );

  let currentUpgrader: string;
  try {
    currentUpgrader = await controller.upgrader();
  } catch {
    currentUpgrader = hre.ethers.ZeroAddress;
  }

  if (currentUpgrader === hre.ethers.ZeroAddress) {
    await migrateV1ToV2({
      hre,
      ControllerFactory,
      admin,
      proxyAddress,
    });
    return;
  }

  await executeScheduledUpgrade({
    hre,
    controller,
    admin,
    proxyAddress,
    currentUpgrader,
    deployments,
    deploymentFile,
  });
}

async function migrateV1ToV2(args: {
  hre: typeof hre;
  ControllerFactory: any;
  admin: any;
  proxyAddress: string;
}) {
  const { hre: h, ControllerFactory, admin, proxyAddress } = args;

  // Read v1's owner via a minimal ABI — the v2 ABI doesn't expose owner().
  const ownerAbi = ["function owner() view returns (address)"];
  const v1View = new h.ethers.Contract(proxyAddress, ownerAbi, admin);
  let currentOwner: string;
  try {
    currentOwner = await v1View.owner();
  } catch (e) {
    throw new Error(
      `Failed to read owner() on proxy ${proxyAddress}. ` +
        `This script expects a v1 IDRPController proxy (with OwnableUpgradeable).`
    );
  }

  if (currentOwner.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(
      `Admin ${admin.address} is not the v1 owner (${currentOwner}). ` +
        `Only the current owner can authorize the v1 → v2 migration.`
    );
  }

  const newUpgrader = admin.address;
  console.log(`\nv1 proxy detected. Running v1 → v2 migration via initializeV2.`);
  console.log(`v1 owner: ${currentOwner}`);
  console.log(`Post-migration upgrader: ${newUpgrader}`);

  // Atomically: deploy new impl, switch proxy, run initializeV2(newUpgrader).
  // `unsafeAllow: ["missing-initializer-call"]` is required because v2 drops
  // OwnableUpgradeable as a parent; the OZ plugin otherwise flags the missing
  // __Ownable_init call. The dropped storage is OZ-namespaced (ERC-7201) so
  // it cannot collide with sequential layout — verified in
  // test/security-audit/V4-2-ControllerUpgraderPattern.ts.
  const upgraded = await h.upgrades.upgradeProxy(proxyAddress, ControllerFactory, {
    call: { fn: "initializeV2", args: [newUpgrader] },
    unsafeAllow: ["missing-initializer-call"],
  });
  await upgraded.waitForDeployment();

  console.log("\nIDRPController upgraded (v1 → v2) successfully.");
  console.log("Proxy:", await upgraded.getAddress());
  console.log("upgrader() (post-migration):", await upgraded.upgrader());
  console.log(
    `\nFuture upgrades now go through the 48h timelock flow. Run:\n` +
      `  1) npx hardhat run ./scripts/schedule-upgrade-controller.ts --network ${h.network.name}\n` +
      `  2) wait 48h\n` +
      `  3) npx hardhat run ./scripts/upgrade-controller.ts --network ${h.network.name}`
  );
}

async function executeScheduledUpgrade(args: {
  hre: typeof hre;
  controller: any;
  admin: any;
  proxyAddress: string;
  currentUpgrader: string;
  deployments: Record<string, string>;
  deploymentFile: string;
}) {
  const {
    hre: h,
    controller,
    admin,
    proxyAddress,
    currentUpgrader,
    deployments,
    deploymentFile,
  } = args;

  if (currentUpgrader.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(
      `Admin ${admin.address} is not the current upgrader (${currentUpgrader}). ` +
        `Use the correct signer or rotate via setUpgrader.`
    );
  }

  const scheduledImpl: string = await controller.scheduledImplementation();
  if (scheduledImpl === h.ethers.ZeroAddress) {
    console.log("No upgrade scheduled on-chain.");
    console.log(
      `Run: npx hardhat run ./scripts/schedule-upgrade-controller.ts --network ${h.network.name}`
    );
    return;
  }

  const scheduledAt: bigint = await controller.upgradeScheduledAt();
  const delay: bigint = await controller.UPGRADE_DELAY();
  const executableAfter = scheduledAt + delay;
  const now = BigInt(Math.floor(Date.now() / 1000));

  console.log("\n--- Scheduled Upgrade ---");
  console.log("Proxy:", proxyAddress);
  console.log("Scheduled implementation:", scheduledImpl);
  console.log(
    "Scheduled at:",
    new Date(Number(scheduledAt) * 1000).toISOString()
  );
  console.log(
    "Executable after:",
    new Date(Number(executableAfter) * 1000).toISOString()
  );
  console.log("Current time:", new Date(Number(now) * 1000).toISOString());

  if (now < executableAfter) {
    const remaining = Number(executableAfter - now);
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    console.log(`\nTimelock not expired. Remaining: ${hours}h ${minutes}m`);
    return;
  }

  // Cross-check deployment file vs on-chain (on-chain is source of truth).
  const savedImpl = deployments["IDRPControllerScheduledImpl"];
  if (savedImpl && savedImpl.toLowerCase() !== scheduledImpl.toLowerCase()) {
    console.warn(
      `WARNING: deployment file has ${savedImpl} but on-chain has ${scheduledImpl}.`
    );
    console.warn("Using on-chain value.");
  }

  console.log("\nTimelock expired. Executing upgrade...");
  // Direct upgradeToAndCall so we pass the exact scheduled implementation —
  // OZ's upgradeProxy redeploys by default, which would produce a different
  // address and fail the "Upgrade not scheduled" check in _authorizeUpgrade.
  const tx = await (controller as any).upgradeToAndCall(scheduledImpl, "0x");
  const receipt = await tx.wait();
  console.log("upgradeToAndCall tx:", receipt?.hash);

  const newScheduled: string = await controller.scheduledImplementation();
  console.log("scheduledImplementation (should be 0x0):", newScheduled);

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

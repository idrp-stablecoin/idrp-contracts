import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * IDRP upgrade executor.
 *
 * Two modes, auto-detected from proxy state:
 *
 * 1) v1 → v2 migration (instant, still authorized by legacy UPGRADER_ROLE):
 *    - Triggered when `upgrader()` returns address(0) — v1 proxies don't have
 *      the `upgrader` slot, so the read returns zero.
 *    - Caller must currently hold the legacy UPGRADER_ROLE on the proxy.
 *    - Executes upgradeToAndCall(newImpl, initializeV2(_upgrader, legacyHolders))
 *      atomically: implementation swap + single-upgrader wiring + revoke of every
 *      historical legacy-role grantee in one tx.
 *    - Requires deployment/chain-{chainId}-legacy-upgrader-holders.json produced
 *      by scripts/list-upgrader-holders.ts.
 *
 * 2) v2 → v3+ (timelocked):
 *    - Caller must equal `upgrader()` (typically the Safe).
 *    - Must be preceded by scripts/schedule-upgrade.ts + 48h wait.
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

  const proxyAddress = deployments["IDRP"];
  if (!proxyAddress) {
    throw new Error("IDRP proxy address not found in deployment file");
  }
  console.log("IDRP proxy:", proxyAddress);

  const idrp = await hre.ethers.getContractAt("IDRP", proxyAddress, admin);
  const IDRP = await hre.ethers.getContractFactory("IDRP", admin);

  let currentUpgrader: string;
  try {
    currentUpgrader = await idrp.upgrader();
  } catch {
    currentUpgrader = hre.ethers.ZeroAddress;
  }

  if (currentUpgrader === hre.ethers.ZeroAddress) {
    await migrateV1ToV2({
      hre,
      idrp,
      IDRP,
      admin,
      networkId,
      deploymentDir,
      proxyAddress,
    });
    return;
  }

  await executeScheduledUpgrade({
    hre,
    idrp,
    IDRP,
    admin,
    proxyAddress,
    currentUpgrader,
    deployments,
    deploymentFile,
  });
}

async function migrateV1ToV2(args: {
  hre: typeof hre;
  idrp: any;
  IDRP: any;
  admin: any;
  networkId: number;
  deploymentDir: string;
  proxyAddress: string;
}) {
  const {
    hre: h,
    idrp,
    IDRP,
    admin,
    networkId,
    deploymentDir,
    proxyAddress,
  } = args;

  const legacyHoldersFile = path.join(
    deploymentDir,
    `chain-${networkId}-legacy-upgrader-holders.json`
  );
  if (!fs.existsSync(legacyHoldersFile)) {
    throw new Error(
      `Legacy UPGRADER_ROLE holders file missing: ${legacyHoldersFile}\n` +
        `Run: npx hardhat run ./scripts/list-upgrader-holders.ts --network ${h.network.name}`
    );
  }
  const legacyHolders: string[] = JSON.parse(
    fs.readFileSync(legacyHoldersFile, "utf-8")
  );
  console.log(
    `\nv1 proxy detected. Running v1 → v2 migration via initializeV2.`
  );
  console.log(`Legacy holders to revoke (${legacyHolders.length}):`);
  legacyHolders.forEach((addr) => console.log(`  - ${addr}`));

  // On v1, caller needs legacy UPGRADER_ROLE to pass v1's _authorizeUpgrade.
  const legacyRole = h.ethers.keccak256(
    h.ethers.toUtf8Bytes("UPGRADER_ROLE")
  );
  const hasLegacyRole: boolean = await idrp.hasRole(legacyRole, admin.address);
  if (!hasLegacyRole) {
    throw new Error(
      `Admin ${admin.address} does not hold legacy UPGRADER_ROLE on IDRP. ` +
        `Only an address with UPGRADER_ROLE can trigger the v1 → v2 migration.`
    );
  }

  const newUpgrader = admin.address;
  console.log(`Post-migration upgrader: ${newUpgrader}`);

  const upgraded = await h.upgrades.upgradeProxy(proxyAddress, IDRP, {
    call: { fn: "initializeV2", args: [newUpgrader, legacyHolders] },
  });
  await upgraded.waitForDeployment();

  console.log("\nIDRP upgraded (v1 → v2) successfully.");
  console.log("Proxy:", await upgraded.getAddress());
  console.log("upgrader() (post-migration):", await idrp.upgrader());
  console.log(
    `\nFuture upgrades now go through the 48h timelock flow. Run:\n` +
      `  1) npx hardhat run ./scripts/schedule-upgrade.ts --network ${h.network.name}\n` +
      `  2) wait 48h\n` +
      `  3) npx hardhat run ./scripts/upgrade.ts --network ${h.network.name}`
  );
}

async function executeScheduledUpgrade(args: {
  hre: typeof hre;
  idrp: any;
  IDRP: any;
  admin: any;
  proxyAddress: string;
  currentUpgrader: string;
  deployments: Record<string, string>;
  deploymentFile: string;
}) {
  const {
    hre: h,
    proxyAddress,
    currentUpgrader,
    deployments,
    deploymentFile,
  } = args;
  let { idrp, admin } = args;

  // The upgrader key differs per network (Base Sepolia's token upgrader is not
  // Kairos's), so resolve the signer from on-chain state rather than an index.
  if (currentUpgrader.toLowerCase() !== admin.address.toLowerCase()) {
    const all = await h.ethers.getSigners();
    const match = all.find(
      (s: { address: string }) =>
        s.address.toLowerCase() === currentUpgrader.toLowerCase()
    );
    if (!match) {
      throw new Error(
        `None of the ${all.length} configured signer(s) is the current upgrader ` +
          `(${currentUpgrader}). Available: ` +
          all.map((s: { address: string }) => s.address).join(", ")
      );
    }
    console.log("Re-resolved upgrader signer:", match.address);
    admin = match;
    idrp = idrp.connect(match);
  }

  const scheduledImpl: string = await idrp.scheduledImplementation();
  if (scheduledImpl === h.ethers.ZeroAddress) {
    console.log("No upgrade scheduled on-chain.");
    console.log(
      `Run: npx hardhat run ./scripts/schedule-upgrade.ts --network ${h.network.name}`
    );
    return;
  }

  const scheduledAt: bigint = await idrp.upgradeScheduledAt();
  const delay: bigint = await idrp.UPGRADE_DELAY();
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
  const savedImpl = deployments["IDRPScheduledImpl"];
  if (savedImpl && savedImpl.toLowerCase() !== scheduledImpl.toLowerCase()) {
    console.warn(
      `WARNING: deployment file has ${savedImpl} but on-chain has ${scheduledImpl}.`
    );
    console.warn("Using on-chain value.");
  }

  console.log("\nTimelock expired. Executing upgrade...");
  // Direct upgradeToAndCall so we pass the exact scheduled implementation — OZ's
  // upgradeProxy redeploys by default, which would produce a different address
  // and fail the "Upgrade not scheduled" check.
  const tx = await (idrp as any).upgradeToAndCall(scheduledImpl, "0x");
  const receipt = await tx.wait();
  console.log("upgradeToAndCall tx:", receipt?.hash);

  const newScheduled: string = await idrp.scheduledImplementation();
  console.log("scheduledImplementation (should be 0x0):", newScheduled);

  delete deployments["IDRPScheduledImpl"];
  delete deployments["IDRPScheduledAt"];
  delete deployments["IDRPExecutableAfter"];
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log("Cleaned up scheduled entries from deployment file.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

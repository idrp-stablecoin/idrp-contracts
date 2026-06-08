import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/v1-to-v2/upgrade.ts
 *
 * Executes the v1 → v2 migration on the IDRP proxy. Atomic
 * upgradeToAndCall(newImpl, initializeV2(newUpgrader, legacyHolders)):
 *   - swaps the implementation to the IDRPv2 deployed by prepare-upgrade.ts
 *   - sets `upgrader` to the configured admin
 *   - revokes legacy UPGRADER_ROLE from every holder in the legacy-holders file
 *
 * Run validate.ts first, then prepare-upgrade.ts, then this.
 *
 * Usage:
 *   npx hardhat run scripts/v1-to-v2/upgrade.ts --network <testnet>
 */

async function main() {
  const networkId = hre.network.config.chainId ?? 0;
  console.log(`Network: ${hre.network.name} (chainId ${networkId})\n`);

  const deploymentDir = path.join(hre.config.paths.root, "deployment");
  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const proxyAddress = deployments.IDRP;
  const preparedImpl = deployments.IDRPv2PreparedImpl;
  if (!proxyAddress) throw new Error("deployments.IDRP not set.");
  if (!preparedImpl) {
    throw new Error(
      `deployments.IDRPv2PreparedImpl not set. Run prepare-upgrade.ts first.`
    );
  }

  const signers = await hre.ethers.getSigners();
  const admin = signers[1];
  console.log(`Admin:        ${admin.address}`);
  console.log(`Proxy:        ${proxyAddress}`);
  console.log(`Prepared v2:  ${preparedImpl}\n`);

  const legacyHoldersFile = path.join(
    deploymentDir,
    `chain-${networkId}-legacy-upgrader-holders.json`
  );
  if (!fs.existsSync(legacyHoldersFile)) {
    throw new Error(
      `Legacy UPGRADER_ROLE holders file missing: ${legacyHoldersFile}\n` +
        `Run: npx hardhat run scripts/list-upgrader-holders.ts --network ${hre.network.name}`
    );
  }
  const legacyHolders: string[] = JSON.parse(
    fs.readFileSync(legacyHoldersFile, "utf-8")
  );
  console.log(`Legacy UPGRADER_ROLE holders (${legacyHolders.length}):`);
  legacyHolders.forEach((h) => console.log(`  - ${h}`));
  console.log("");

  // Pre-condition: admin must currently hold legacy UPGRADER_ROLE (v1's
  // _authorizeUpgrade gate).
  const idrpAsV1 = new hre.ethers.Contract(
    proxyAddress,
    [
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function upgrader() view returns (address)",
    ],
    admin
  );

  // Confirm v1 (upgrader() should revert).
  try {
    await idrpAsV1.upgrader();
    throw new Error(
      "upgrader() did NOT revert — proxy is not at v1. Aborting to avoid double-migration."
    );
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("Aborting")) throw e;
    // expected revert; continue.
  }

  const legacyRole = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("UPGRADER_ROLE")
  );
  const hasLegacyRole = await idrpAsV1.hasRole(legacyRole, admin.address);
  if (!hasLegacyRole) {
    throw new Error(
      `Admin ${admin.address} does not hold legacy UPGRADER_ROLE on IDRP. ` +
        `Only a holder of UPGRADER_ROLE can authorize the v1 implementation swap.`
    );
  }

  const newUpgrader = admin.address;
  console.log(`New upgrader (post-migration): ${newUpgrader}\n`);

  // Execute atomically.
  const IDRPv2Factory = await hre.ethers.getContractFactory("IDRPv2", admin);
  const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, IDRPv2Factory, {
    kind: "uups",
    unsafeAllow: ["missing-initializer-call"],
    call: { fn: "initializeV2", args: [newUpgrader, legacyHolders] },
  });
  await upgraded.waitForDeployment();

  // Post-migration sanity.
  const idrpAsV2 = await hre.ethers.getContractAt(
    "IDRPv2",
    proxyAddress,
    admin
  );
  const upgraderAfter = await idrpAsV2.upgrader();
  console.log(`✓ IDRP migrated v1 → v2`);
  console.log(`  proxy:        ${proxyAddress}`);
  console.log(`  upgrader():   ${upgraderAfter}`);

  // Clear the prepared-impl record now that it's deployed.
  delete deployments.IDRPv2PreparedImpl;
  delete deployments.IDRPv2PreparedImplDeployedAt;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(`\nNext step: continue with v2 → v3 via the top-level scripts/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

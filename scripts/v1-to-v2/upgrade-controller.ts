import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/v1-to-v2/upgrade-controller.ts
 *
 * Executes the v1 → v2 migration on the IDRPController proxy. v1's
 * _authorizeUpgrade was `onlyOwner` (not role-based), so the caller must
 * currently equal the proxy's Ownable owner.
 *
 * Atomic upgradeToAndCall(newImpl, initializeV2(newUpgrader)).
 *
 * Usage:
 *   npx hardhat run scripts/v1-to-v2/upgrade-controller.ts --network <testnet>
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
  console.log(`Admin:        ${admin.address}`);
  console.log(`Proxy:        ${proxyAddress}`);
  console.log(`Prepared v2:  ${preparedImpl}\n`);

  // Pre-condition: admin must equal v1's owner().
  const ctrlAsV1 = new hre.ethers.Contract(
    proxyAddress,
    [
      "function owner() view returns (address)",
      "function upgrader() view returns (address)",
    ],
    admin
  );
  try {
    await ctrlAsV1.upgrader();
    throw new Error(
      "upgrader() did NOT revert — Controller is not at v1. Aborting."
    );
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("Aborting")) throw e;
    // expected revert; continue.
  }
  const currentOwner = (await ctrlAsV1.owner()) as string;
  if (currentOwner.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(
      `Admin ${admin.address} does not match Controller owner ${currentOwner}. ` +
        `Only owner can authorize the v1 implementation swap.`
    );
  }

  const newUpgrader = admin.address;
  console.log(`New upgrader (post-migration): ${newUpgrader}\n`);

  const CtrlFactory = await hre.ethers.getContractFactory(
    "IDRPControllerv2",
    admin
  );
  const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, CtrlFactory, {
    kind: "uups",
    unsafeAllow: ["missing-initializer-call"],
    call: { fn: "initializeV2", args: [newUpgrader] },
  });
  await upgraded.waitForDeployment();

  const ctrlAsV2 = await hre.ethers.getContractAt(
    "IDRPControllerv2",
    proxyAddress,
    admin
  );
  const upgraderAfter = await ctrlAsV2.upgrader();
  console.log(`✓ IDRPController migrated v1 → v2`);
  console.log(`  proxy:       ${proxyAddress}`);
  console.log(`  upgrader():  ${upgraderAfter}`);

  delete deployments.IDRPControllerv2PreparedImpl;
  delete deployments.IDRPControllerv2PreparedImplDeployedAt;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(`\nNext step: continue with v2 → v3 via the top-level scripts/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

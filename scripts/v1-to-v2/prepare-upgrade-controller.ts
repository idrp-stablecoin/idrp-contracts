import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/v1-to-v2/prepare-upgrade-controller.ts
 *
 * Same as prepare-upgrade.ts but for IDRPControllerv2. Records under
 * `IDRPControllerv2PreparedImpl`.
 *
 * Usage:
 *   npx hardhat run scripts/v1-to-v2/prepare-upgrade-controller.ts --network <testnet>
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
  if (!proxyAddress) {
    throw new Error("deployments.IDRPController not set — nothing to migrate.");
  }
  console.log(`IDRPController proxy: ${proxyAddress}`);

  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  console.log(`Deployer:             ${deployer.address}\n`);

  // Register the deployed proxy with OZ Upgrades by force-importing it
  // against the legacy source. For Base Sepolia we use the
  // IDRPControllerBaseSepoliaLegacy snapshot (v1 + audit hardening, still
  // Ownable); for everywhere else, the standard IDRPControllerV1Mock
  // (Ownable-only v1).
  const fromName =
    networkId === 84532 ? "IDRPControllerBaseSepoliaLegacy" : "IDRPControllerV1Mock";
  console.log(`Force-importing proxy against legacy source: ${fromName} …`);
  const FromFactory = await hre.ethers.getContractFactory(fromName, deployer);
  await hre.upgrades.forceImport(proxyAddress, FromFactory, { kind: "uups" });

  console.log(`Preparing IDRPControllerv2 implementation …`);
  const CtrlFactory = await hre.ethers.getContractFactory(
    "IDRPControllerv2",
    deployer
  );
  const preparedImpl = (await hre.upgrades.prepareUpgrade(
    proxyAddress,
    CtrlFactory,
    { kind: "uups", unsafeAllow: ["missing-initializer-call"] }
  )) as string;

  console.log(`✓ New IDRPControllerv2 implementation: ${preparedImpl}`);

  deployments.IDRPControllerv2PreparedImpl = preparedImpl;
  deployments.IDRPControllerv2PreparedImplDeployedAt = String(
    Math.floor(Date.now() / 1000)
  );
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(
    `Recorded in deployment/chain-${networkId}.json:\n` +
      `  IDRPControllerv2PreparedImpl: ${preparedImpl}\n` +
      `  IDRPControllerv2PreparedImplDeployedAt: ${deployments.IDRPControllerv2PreparedImplDeployedAt}`
  );

  console.log(
    `\nNext step:\n  npx hardhat run scripts/v1-to-v2/upgrade-controller.ts --network ${hre.network.name}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

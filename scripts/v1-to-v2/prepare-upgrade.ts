import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/v1-to-v2/prepare-upgrade.ts
 *
 * Deploys a fresh IDRPv2 (legacy v2) implementation contract on the
 * target chain and records its address in
 * `deployment/chain-{chainId}.json` under `IDRPv2PreparedImpl`. Does NOT
 * touch the proxy — that happens in upgrade.ts after this.
 *
 * Run validate.ts first.
 *
 * Usage:
 *   npx hardhat run scripts/v1-to-v2/prepare-upgrade.ts --network <testnet>
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

  const proxyAddress = deployments.IDRP;
  if (!proxyAddress) {
    throw new Error("deployments.IDRP not set — nothing to migrate.");
  }
  console.log(`IDRP proxy: ${proxyAddress}`);

  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  console.log(`Deployer:   ${deployer.address}\n`);

  console.log(`Preparing IDRPv2 implementation …`);
  const IDRPv2Factory = await hre.ethers.getContractFactory("IDRPv2", deployer);
  const preparedImpl = (await hre.upgrades.prepareUpgrade(
    proxyAddress,
    IDRPv2Factory,
    { kind: "uups", unsafeAllow: ["missing-initializer-call"] }
  )) as string;

  console.log(`✓ New IDRPv2 implementation: ${preparedImpl}`);

  deployments.IDRPv2PreparedImpl = preparedImpl;
  deployments.IDRPv2PreparedImplDeployedAt = String(
    Math.floor(Date.now() / 1000)
  );
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(
    `Recorded in deployment/chain-${networkId}.json:\n` +
      `  IDRPv2PreparedImpl: ${preparedImpl}\n` +
      `  IDRPv2PreparedImplDeployedAt: ${deployments.IDRPv2PreparedImplDeployedAt}`
  );

  console.log(
    `\nNext step:\n  npx hardhat run scripts/v1-to-v2/upgrade.ts --network ${hre.network.name}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

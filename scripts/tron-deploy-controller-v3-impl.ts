/**
 * Tron mainnet-specific: deploy a fresh IDRPController v3 implementation.
 * Mirror of nile-deploy-controller-v3-impl.ts but targets Tron MAINNET.
 *
 * ⚠ MAINNET: real TRX is spent. Confirm before running.
 *
 * Usage:
 *   npx hardhat run scripts/tron-deploy-controller-v3-impl.ts --network tron
 */
import hre from "hardhat";

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error(`Tron MAINNET only (got ${hre.network.name})`);
  }
  const { deployments } = hre as any;
  const { deploy } = deployments;

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log(`Network:  ${hre.network.name} (TRON MAINNET)`);
  console.log(`Deployer: ${deployerAddress}`);

  const GAS_OPTIONS = { gasLimit: 10_000_000, gasPrice: "420" };

  console.log(`\nDeploying IDRPController v3 implementation (mainnet 48h UPGRADE_DELAY)...`);
  const result = await deploy("IDRPController_v3_Impl_48h", {
    from: deployerAddress,
    contract: "IDRPController",
    args: [],
    log: true,
    ...GAS_OPTIONS,
  });

  console.log(`\n✓ IDRPController v3 impl deployed.`);
  console.log(`  Address (hex):  ${result.address}`);
  console.log(`  txHash:         ${result.transactionHash}`);
  console.log(`\nNext: schedule the upgrade by running:`);
  console.log(`  IMPL=${result.address} npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

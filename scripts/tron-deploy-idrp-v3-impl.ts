/**
 * Tron mainnet-specific: deploy a fresh IDRP v3 implementation contract.
 *
 * Mirror of nile-deploy-idrp-v3-impl.ts but targets Tron MAINNET. Uses
 * hardhat-deploy + @layerzerolabs/hardhat-tron for the deploy.
 *
 * ⚠ MAINNET: real TRX is spent. Confirm before running.
 *
 * Mainnet differences from Nile:
 *   - Network guard: "tron" instead of "nile" / "shasta".
 *   - No 5-minute TESTNET-LOCAL override. Mainnet ships with the canonical
 *     UPGRADE_DELAY = 48 hours baked into source. Do NOT worktree-edit it.
 *   - Artifact name suffix is _48h to make the difference explicit in the
 *     deployments registry.
 *
 * This is step 1 of the v2 -> v3 migration. After this:
 *   - Run scripts/tron-schedule-idrp-upgrade.ts (starts the 48h timelock).
 *   - Wait 48 HOURS (real, on-chain).
 *   - Run scripts/tron-execute-idrp-upgrade.ts (calls upgradeToAndCall +
 *     initializeV3 atomically).
 *
 * Usage:
 *   npx hardhat run scripts/tron-deploy-idrp-v3-impl.ts --network tron
 */
import hre from "hardhat";

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error(`This script is for Tron MAINNET only (got ${hre.network.name})`);
  }
  const { deployments } = hre as any;
  const { deploy } = deployments;

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log(`Network:  ${hre.network.name} (TRON MAINNET)`);
  console.log(`Deployer: ${deployerAddress}`);

  const GAS_OPTIONS = { gasLimit: 10_000_000, gasPrice: "420" };

  console.log(`\nDeploying IDRP v3 implementation (mainnet 48h UPGRADE_DELAY)...`);
  const result = await deploy("IDRP_v3_Impl_48h", {
    from: deployerAddress,
    contract: "IDRP",
    args: [], // impl constructor takes no args
    log: true,
    ...GAS_OPTIONS,
  });

  console.log(`\n✓ IDRP v3 impl deployed.`);
  console.log(`  Address (hex):  ${result.address}`);
  console.log(`  txHash:         ${result.transactionHash}`);
  console.log(`\nNext: schedule the upgrade by running:`);
  console.log(`  IMPL=${result.address} npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

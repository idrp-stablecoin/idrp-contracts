/**
 * Nile-specific: deploy a fresh IDRP v3 implementation contract.
 *
 * Uses hardhat-deploy + @layerzerolabs/hardhat-tron for the Tron-side deploy
 * (avoids the OZ upgrades plugin's eth_getTransactionCount path that breaks
 * on Tron RPCs).
 *
 * This is step 1 of the v2 -> v3 migration. After this:
 *   - Run scheduleUpgrade(impl) on the IDRP proxy.
 *   - Wait 5 min (TESTNET-LOCAL UPGRADE_DELAY).
 *   - Call upgradeToAndCall(impl, initializeV3(admin, controller, upgrader)).
 *
 * Usage:
 *   npx hardhat run scripts/nile-deploy-idrp-v3-impl.ts --network nile
 */
import hre from "hardhat";

async function main() {
  if (hre.network.name !== "nile" && hre.network.name !== "shasta") {
    throw new Error(`This script is for Tron testnets only (got ${hre.network.name})`);
  }
  const { deployments } = hre as any;
  const { deploy } = deployments;

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log(`Network:  ${hre.network.name}`);
  console.log(`Deployer: ${deployerAddress}`);

  const GAS_OPTIONS = { gasLimit: 10_000_000, gasPrice: "420" };

  console.log(`\nDeploying IDRP v3 implementation (uses TESTNET-LOCAL 5min UPGRADE_DELAY)...`);
  const result = await deploy("IDRP_v3_Impl_5min", {
    from: deployerAddress,
    contract: "IDRP",
    args: [], // impl constructor takes no args
    log: true,
    ...GAS_OPTIONS,
  });

  console.log(`\n✓ IDRP v3 impl deployed.`);
  console.log(`  Address (hex):  ${result.address}`);
  console.log(`  txHash:         ${result.transactionHash}`);
  console.log(`\nNext: schedule the upgrade by calling scheduleUpgrade(${result.address}) on the proxy.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

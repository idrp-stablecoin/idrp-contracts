/**
 * Nile-specific: deploy a fresh IDRPController v3 implementation contract.
 * Mirror of nile-deploy-idrp-v3-impl.ts but for the Controller.
 *
 * Usage:
 *   npx hardhat run scripts/nile-deploy-controller-v3-impl.ts --network nile
 */
import hre from "hardhat";

async function main() {
  if (hre.network.name !== "nile" && hre.network.name !== "shasta") {
    throw new Error(`Tron testnets only (got ${hre.network.name})`);
  }
  const { deployments } = hre as any;
  const { deploy } = deployments;

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log(`Network:  ${hre.network.name}`);
  console.log(`Deployer: ${deployerAddress}`);

  const GAS_OPTIONS = { gasLimit: 10_000_000, gasPrice: "420" };

  console.log(`\nDeploying IDRPController v3 implementation...`);
  const result = await deploy("IDRPController_v3_Impl_5min", {
    from: deployerAddress,
    contract: "IDRPController",
    args: [],
    log: true,
    ...GAS_OPTIONS,
  });

  console.log(`\n✓ IDRPController v3 impl deployed.`);
  console.log(`  Address (hex):  ${result.address}`);
  console.log(`  txHash:         ${result.transactionHash}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

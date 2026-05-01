import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Deploys IDRPSanctionsRegistry. Roles wired at construction:
 *   MULTISIG_ROLE     = SANCTIONS_MULTISIG (env or first signer)
 *   KEEPER_ROLE       = SANCTIONS_KEEPER   (env or first signer)
 *   DEFAULT_ADMIN     = SANCTIONS_MULTISIG
 *
 * Re-runs are idempotent: if a deployment file already lists the contract for
 * the current chainId, the script exits without re-deploying.
 */
async function main() {
  const name = "IDRPSanctionsRegistry";
  const networkId = hre.network.config.chainId ?? 0;
  const [deployer] = await hre.ethers.getSigners();

  const multisig = process.env.SANCTIONS_MULTISIG ?? deployer.address;
  const keeper = process.env.SANCTIONS_KEEPER ?? deployer.address;

  console.log(`network chainId : ${networkId}`);
  console.log(`deployer        : ${deployer.address}`);
  console.log(`multisig (admin): ${multisig}`);
  console.log(`keeper          : ${keeper}`);
  if (multisig === deployer.address) {
    console.warn("⚠️  multisig defaulted to deployer EOA — set SANCTIONS_MULTISIG before mainnet deploy.");
  }

  const deploymentDir = path.join(hre.config.paths.root || process.cwd(), "./deployment");
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  let deployments: Record<string, string> = {};
  if (fs.existsSync(deploymentFile)) {
    deployments = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
  }

  if (deployments[name]) {
    console.log(`${name} already deployed at ${deployments[name]} — skipping.`);
    return;
  }

  const Factory = await hre.ethers.getContractFactory(name);
  const tx = await Factory.deploy(multisig, keeper);
  await tx.waitForDeployment();

  const address = await tx.getAddress();
  const deployTx = tx.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const gasUsed = receipt?.gasUsed ?? 0n;

  console.log(`✓ ${name} deployed at ${address} (gas: ${gasUsed.toString()})`);

  deployments[name] = address;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

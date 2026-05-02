import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Deploys SanctionsList — IDRP's verbatim Chainalysis-clone contract.
 * The deployer becomes the owner (Ownable v5). Transfer ownership via
 * `transferOwnership(newOwner)` after deploy if you want a Safe to manage
 * the list instead of the deployer EOA.
 *
 * Re-runs are idempotent: if a deployment file already lists the contract for
 * the current chainId, the script exits without re-deploying.
 *
 * Strategy reminder (per WhatsApp 2026-05-02): we only deploy this on chains
 * Chainalysis does NOT support yet — primarily Kaia. On Ethereum / BSC /
 * Polygon, point IDRP at the real Chainalysis oracle (no deploy cost).
 */
async function main() {
  const name = "SanctionsList";
  const networkId = hre.network.config.chainId ?? 0;
  const [deployer] = await hre.ethers.getSigners();

  console.log(`network chainId : ${networkId}`);
  console.log(`deployer (owner): ${deployer.address}`);

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
  const tx = await Factory.deploy();
  await tx.waitForDeployment();

  const address = await tx.getAddress();
  const deployTx = tx.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const gasUsed = receipt?.gasUsed ?? 0n;

  console.log(`✓ ${name} deployed at ${address} (gas: ${gasUsed.toString()})`);

  deployments[name] = address;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));

  console.log("");
  console.log("Next steps:");
  console.log(`  1) (optional) transfer ownership to a Safe:`);
  console.log(`     await sanctionsList.transferOwnership('0x...Safe')`);
  console.log(`  2) seed the list — see scripts/sanctions/seed-from-opensanctions.ts`);
  console.log(`  3) when IDRP V3 is live, wire it up:`);
  console.log(`     await idrp.setSanctionsList('${address}')`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

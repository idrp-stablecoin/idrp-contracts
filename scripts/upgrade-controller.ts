import fs from "fs";
import path from "path";
import hre from "hardhat";

async function main() {
  const name = "IDRPController";
  const networkId = hre.network.config.chainId ?? 8545;
  const signers = await hre.ethers.getSigners();
  const admin = signers[1];
  console.log("admin", admin.address);

  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );

  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);

  // Fetch existing deployments
  let deployments: Record<string, string> = {};
  if (fs.existsSync(deploymentFile)) {
    deployments = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
  }

  // Upgrade IDRPController
  console.log("Upgrading IDRPController...");
  const IDRPController = await hre.ethers.getContractFactory(
    "IDRPController",
    admin
  );
  const contract = await hre.upgrades.upgradeProxy(
    deployments["IDRPController"],
    IDRPController
    // {
    // redeployImplementation: "always",
    // }
  );
  await contract.waitForDeployment();

  console.log(`IDRPController upgraded with proxy: ${contract.target}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

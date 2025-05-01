import fs from "fs";
import path from "path";
import hre from "hardhat";

async function main() {
  const name = "IDRPController";
  const networkId = hre.network.config.chainId ?? 8545;
  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];

  console.log("deployer", deployer.address);

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

  // Return if contract is already deployed
  if (deployments[name]) {
    console.log(`Contract ${name} already deployed to: ${deployments[name]}`);
    return;
  }

  console.log(`Deploying to network: ${networkId}`);

  // Deploy contracts
  console.log("Deploying IDRPController...");
  // const IDRPController = await hre.ethers.getContractFactory("IDRPController")
  // const contract = await IDRPController.deploy(deployments["IDRP"], deployer.address)
  const contract = await hre.upgrades.deployProxy(
    await hre.ethers.getContractFactory("IDRPController"),
    [deployments["IDRP"], deployer.address]
  );
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  console.log(`IDRPController deployed to: ${contractAddress}`);

  // Add address to deployments
  deployments[name] = contractAddress;
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
  console.log(`Deployment data saved to: ${deploymentFile}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

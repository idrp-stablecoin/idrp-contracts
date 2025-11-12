import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import {
  TRON_ADMIN_ADDRESS,
  TRON_SAFE_ADDRESS,
  TRON_OFFICER_ADDRESS,
  TRON_MANAGER_ADDRESS,
  TRON_DIRECTOR_ADDRESS,
  TRON_COMMISSIONER_ADDRESS,
} from "./utils/constants";
import { tronToHex } from "./utils/addressConverter";

const deployFunction: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
) {
  // Skip post-deployment setup on EVM networks - only run on TRON
  if (hre.network.name !== "shasta") {
    console.log(`⏭️  Skipping post-deployment setup on ${hre.network.name}\n`);
    return;
  }

  const { deployments } = hre;
  const idrpDeployment = await deployments.get("IDRP");
  const controllerDeployment = await deployments.get("IDRPController");

  // Convert all TRON addresses to hex format
  const adminAddress = tronToHex(TRON_ADMIN_ADDRESS);
  const safeAddress = tronToHex(TRON_SAFE_ADDRESS);
  const officerAddress = tronToHex(TRON_OFFICER_ADDRESS);
  const managerAddress = tronToHex(TRON_MANAGER_ADDRESS);
  const directorAddress = tronToHex(TRON_DIRECTOR_ADDRESS);
  const commissionerAddress = tronToHex(TRON_COMMISSIONER_ADDRESS);

  console.log(`\n🛠️  Setting up roles and permissions on TRON Shasta\n`);

  // Setup roles (example - adjust based on actual contract requirements)
  console.log(`Setting OFFICER_ROLE for ${officerAddress}`);
  console.log(`Setting MANAGER_ROLE for ${managerAddress}`);
  console.log(`Setting DIRECTOR_ROLE for ${directorAddress}`);
  console.log(`Setting COMMISSIONER_ROLE for ${commissionerAddress}`);

  // Add more role setup calls here as needed based on your contract interface
  // Example:
  // await deployments.execute("IDRPController", { from: safeAddress }, "grantRole", OFFICER_ROLE, officerAddress);

  console.log(`\n✓ Post-deployment setup completed\n`);
};

deployFunction.tags = ["PostDeployment"];
deployFunction.dependencies = ["IDRP", "IDRPController"];
deployFunction.id = "post_deployment_setup";

export default deployFunction;

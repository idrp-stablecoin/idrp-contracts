import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ADMIN_ADDRESS, TRON_ADMIN_ADDRESS } from "../scripts/utils/constants";
import { tronToHex } from "../scripts/utils/addressConverter";

const deployFunction: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Get deployed IDRP address from previous stage
  const idrpDeployment = await deployments.get("IDRP");

  // Convert TRON addresses to hex format
  let adminAddress: string;
  let safeAddress: string;
  if (hre.network.name === "shasta" || hre.network.name === "tron") {
    adminAddress = tronToHex(TRON_ADMIN_ADDRESS);
    safeAddress = tronToHex(TRON_ADMIN_ADDRESS);
  } else {
    throw new Error("this deployment script is only for TRON networks");
  }

  console.log(
    `\n🚀 Deploying IDRPController to ${hre.network.name} | Admin: ${adminAddress}\n`
  );
  console.log(`   IDRP Token: ${idrpDeployment.address}`);
  console.log(`   Safe Address: ${safeAddress}`);

  const result = await deploy("IDRPController", {
    from: deployer,
    proxy: {
      proxyContract: "UUPS",
      execute: {
        init: {
          methodName: "initialize",
          args: [idrpDeployment.address, safeAddress],
        },
      },
    },
    // proxy: true, // The default Proxy is both ERC-1967 and ERC-173 Compliant
    // args: [idrpDeployment.address, safeAddress],
    log: true,
  });

  console.log(`✓ IDRPController: ${result.address}`);
};

deployFunction.tags = ["IDRPController"];
deployFunction.dependencies = ["IDRP"];
deployFunction.id = "deploy_idrp_controller";

export default deployFunction;

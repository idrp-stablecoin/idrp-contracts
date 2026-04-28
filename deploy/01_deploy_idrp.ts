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

  // Determine admin address based on network
  // Convert TRON base58 addresses to hex format for compatibility with ethers
  let adminAddress: string;
  if (hre.network.name === "shasta" || hre.network.name === "tron") {
    adminAddress = tronToHex(TRON_ADMIN_ADDRESS);
  } else {
    throw new Error("this deployment script is only for TRON networks");
  }

  console.log(
    `\n🚀 Deploying IDRP to ${hre.network.name} | Admin: ${adminAddress}\n`
  );

  const result = await deploy("IDRP", {
    from: deployer,
    proxy: {
      proxyContract: "UUPS",
      upgradeFunction: {
        methodName: "upgradeToAndCall",
        upgradeArgs: ["{implementation}", "{data}"],
      },
      execute: {
        init: {
          methodName: "initialize",
          args: [adminAddress],
        },
      },
    },
    // proxy: true, // The default Proxy is both ERC-1967 and ERC-173 Compliant
    // args: [adminAddress],
    log: true,
  });

  console.log(`✓ IDRP: ${result.address}`);
};

deployFunction.tags = ["IDRP"];
deployFunction.id = "deploy_idrp";

export default deployFunction;

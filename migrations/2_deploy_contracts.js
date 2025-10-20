const { deployProxy } = require("@openzeppelin/truffle-upgrades");
const { tronAddressToEthFormatAddress } = require("./utils/misc");

const IDRP = artifacts.require("IDRP");
const IDRPController = artifacts.require("IDRPController");

module.exports = async function (deployer, network, accounts) {
  try {
    deployer.trufflePlugin = true;
    const superAdmin = accounts;
    const superAdminHex = tronAddressToEthFormatAddress(superAdmin);
    console.log("[1_deploy_contracts] Deploying...", {
      superAdmin,
      superAdminHex,
    });

    const idrp = await deployProxy(IDRP, [superAdminHex], { deployer });
    console.log("[1_deploy_contracts] Deployed IDRP at", idrp.address);
    const idrpController = await deployProxy(
      IDRPController,
      [idrp.address, superAdminHex],
      { deployer }
    );
    console.log(
      "[1_deploy_contracts] Deployed IDRPController at",
      idrpController.address
    );
  } catch (error) {
    console.error("[1_deploy_contracts] deploy error", error);
  }
};

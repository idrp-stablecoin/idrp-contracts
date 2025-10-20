const { sleep } = require("./utils/misc");

const IDRP = artifacts.require("IDRP");
const IDRPController = artifacts.require("IDRPController");

module.exports = async function (deployer, network, accounts) {
  try {
    const superAdmin = accounts;

    // Sleep
    console.log("[3_setup_idrp] Sleeping for 1 seconds...");
    await sleep(1000);
    console.log("[3_setup_idrp] Awake now, proceeding...");

    const idrp = await IDRP.deployed();
    const idrpController = await IDRPController.deployed();

    const DEFAULT_ADMIN_ROLE = await idrp.DEFAULT_ADMIN_ROLE();
    const PAUSER_ROLE = await idrp.PAUSER_ROLE();
    const MINTER_ROLE = await idrp.MINTER_ROLE();
    const FREEZER_ROLE = await idrp.FREEZER_ROLE();
    const UPGRADER_ROLE = await idrp.UPGRADER_ROLE();

    // Check initial roles
    console.log(
      "[3_setup_idrp] superAdmin hasRole DEFAULT_ADMIN_ROLE",
      await idrp.hasRole(DEFAULT_ADMIN_ROLE, superAdmin)
    );
    console.log(
      "[3_setup_idrp] superAdmin hasRole PAUSER_ROLE",
      await idrp.hasRole(PAUSER_ROLE, superAdmin)
    );
    console.log(
      "[3_setup_idrp] superAdmin hasRole MINTER_ROLE",
      await idrp.hasRole(MINTER_ROLE, superAdmin)
    );
    console.log(
      "[3_setup_idrp] superAdmin hasRole FREEZER_ROLE",
      await idrp.hasRole(FREEZER_ROLE, superAdmin)
    );
    console.log(
      "[3_setup_idrp] superAdmin hasRole UPGRADER_ROLE",
      await idrp.hasRole(UPGRADER_ROLE, superAdmin)
    );

    // Setup roles for IDRPController
    const idrpControllerAddress = idrpController.address;
    await idrp.grantRole(PAUSER_ROLE, idrpControllerAddress, {
      from: superAdmin,
    });
    console.log(
      "[3_setup_idrp] Granted PAUSER_ROLE to IDRPController at",
      idrpControllerAddress
    );
    await idrp.grantRole(MINTER_ROLE, idrpControllerAddress, {
      from: superAdmin,
    });
    console.log(
      "[3_setup_idrp] Granted MINTER_ROLE to IDRPController at",
      idrpControllerAddress
    );
    await idrp.grantRole(FREEZER_ROLE, idrpControllerAddress, {
      from: superAdmin,
    });
    console.log(
      "[3_setup_idrp] Granted FREEZER_ROLE to IDRPController at",
      idrpControllerAddress
    );

    // Set depository wallet
    // const depositoryWalletTobeSetted = "";
    // console.log("[3_setup_idrp] Setting depositoryWallet to:", depositoryWalletTobeSetted);
    // console.log("[3_setup_idrp] depositoryWallet before set", await idrp.depositoryWallet());
    // await idrp.setDepositoryWallet(depositoryWalletTobeSetted, { from: superAdmin });
    // console.log("[3_setup_idrp] depositoryWallet after set", await idrp.depositoryWallet());
  } catch (error) {
    console.error("[3_setup_idrp] setup error", error);
  }
};

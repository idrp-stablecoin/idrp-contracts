const {
  officerAddress,
  managerAddress,
  directorAddress,
  commissionerAddress,
  adminAddress,
  MaxUint256,
  ONE_HUNDRED_MILLION,
  FIVE_HUNDRED_MILLION,
  ONE_BILLION,
  TEN_BILLION,
  OPERATION,
} = require("./utils/constants");
const { sleep } = require("./utils/misc");
const IDRPController = artifacts.require("IDRPController");

module.exports = async function (deployer, network, accounts) {
  try {
    const superAdmin = accounts;

    console.log("[4_setup_idrp_controller] accounts:", {
      superAdmin,
      officerAddress,
      managerAddress,
      directorAddress,
      commissionerAddress,
      adminAddress,
    });

    // Sleep
    console.log("[4_setup_idrp_controller] Sleeping for 1 seconds...");
    await sleep(1000);
    console.log("[4_setup_idrp_controller] Awake now, proceeding...");

    const idrpController = await IDRPController.deployed();

    // Setup roles
    const ADMIN_ROLE = await idrpController.ADMIN_ROLE();
    const OFFICER_ROLE = await idrpController.OFFICER_ROLE();
    const MANAGER_ROLE = await idrpController.MANAGER_ROLE();
    const DIRECTOR_ROLE = await idrpController.DIRECTOR_ROLE();
    const COMMISSIONER_ROLE = await idrpController.COMMISSIONER_ROLE();
    console.log("[4_setup_idrp_controller] Roles:", {
      ADMIN_ROLE,
      OFFICER_ROLE,
      MANAGER_ROLE,
      DIRECTOR_ROLE,
      COMMISSIONER_ROLE,
    });
    await idrpController.grantRole(ADMIN_ROLE, adminAddress, {
      from: superAdmin,
    });
    console.log(
      "[4_setup_idrp_controller] Granted ADMIN_ROLE to",
      adminAddress
    );
    await idrpController.grantRole(OFFICER_ROLE, officerAddress, {
      from: superAdmin,
    });
    console.log(
      "[4_setup_idrp_controller] Granted OFFICER_ROLE to",
      officerAddress
    );
    await idrpController.grantRole(MANAGER_ROLE, managerAddress, {
      from: superAdmin,
    });
    console.log(
      "[4_setup_idrp_controller] Granted MANAGER_ROLE to",
      managerAddress
    );
    await idrpController.grantRole(DIRECTOR_ROLE, directorAddress, {
      from: superAdmin,
    });
    console.log(
      "[4_setup_idrp_controller] Granted DIRECTOR_ROLE to",
      directorAddress
    );
    await idrpController.grantRole(COMMISSIONER_ROLE, commissionerAddress, {
      from: superAdmin,
    });
    console.log(
      "[4_setup_idrp_controller] Granted COMMISSIONER_ROLE to",
      commissionerAddress
    );

    // Set quorum rules
    // await idrpController.setQuorumRules(
    //   OPERATION.MINT, // uint8
    //   [[0, ONE_HUNDRED_MILLION, [OFFICER_ROLE]]], // Array params
    //   { from: superAdmin }
    // );
    console.log("passed");
    await idrpController.setQuorumRules(
      OPERATION.MINT,
      [
        // 0 - 100M: Officer
        [0, ONE_HUNDRED_MILLION, [OFFICER_ROLE]],

        // 100M - 500M: Officer + Manager
        [
          ONE_HUNDRED_MILLION,
          FIVE_HUNDRED_MILLION,
          [OFFICER_ROLE, MANAGER_ROLE],
        ],

        // 500M - 1B: Officer + Manager + Director
        [
          FIVE_HUNDRED_MILLION,
          ONE_BILLION,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        ],

        // 1B - MaxUint: Officer + Manager + Director + Commissioner
        [
          ONE_BILLION,
          MaxUint256,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
        ],
      ],
      { from: superAdmin }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for MINT operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.BURN,
      [
        // 0 - 100M: Officer
        [0, ONE_HUNDRED_MILLION, [OFFICER_ROLE]],

        // 100M - 500M: Officer + Manager
        [
          ONE_HUNDRED_MILLION,
          FIVE_HUNDRED_MILLION,
          [OFFICER_ROLE, MANAGER_ROLE],
        ],

        // 500M - 1B: Officer + Manager + Director
        [
          FIVE_HUNDRED_MILLION,
          ONE_BILLION,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        ],

        // 1B - MaxUint: Officer + Manager + Director + Commissioner
        [
          ONE_BILLION,
          MaxUint256,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
        ],
      ],
      { from: superAdmin }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for BURN operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.FREEZE,
      [
        // 0 - 500M: Officer
        [0, FIVE_HUNDRED_MILLION, [OFFICER_ROLE]],

        // 500M - 1B: Officer + Manager
        [FIVE_HUNDRED_MILLION, ONE_BILLION, [OFFICER_ROLE, MANAGER_ROLE]],

        // 1B - 10B: Officer + Manager + Director
        [ONE_BILLION, TEN_BILLION, [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE]],

        // 10B - MaxUint: Officer + Manager + Director + Commissioner
        [
          TEN_BILLION,
          MaxUint256,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
        ],
      ],
      { from: superAdmin }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for FREEZE operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.UNFREEZE,
      [
        // 0 - 500M: Officer
        [0, FIVE_HUNDRED_MILLION, [OFFICER_ROLE]],

        // 500M - 1B: Officer + Manager
        [FIVE_HUNDRED_MILLION, ONE_BILLION, [OFFICER_ROLE, MANAGER_ROLE]],

        // 1B - 10B: Officer + Manager + Director
        [ONE_BILLION, TEN_BILLION, [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE]],

        // 10B - MaxUint: Officer + Manager + Director + Commissioner
        [
          TEN_BILLION,
          MaxUint256,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
        ],
      ],
      {
        from: superAdmin,
      }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for UNFREEZE operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.PAUSE,
      [
        // Any amount: Director + Manager
        [0, MaxUint256, [DIRECTOR_ROLE, MANAGER_ROLE]],
      ],
      {
        from: superAdmin,
      }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for PAUSE operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.UNPAUSE,
      [
        // Any amount: Officer + Manager + Director + Commissioner
        [
          0,
          MaxUint256,
          [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
        ],
      ],
      {
        from: superAdmin,
      }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for UNPAUSE operation successfully"
    );

    console.log(
      "[4_setup_idrp_controller] IDRPController setup completed successfully"
    );
  } catch (error) {
    console.error("[4_setup_idrp_controller] setup error", error);
    console.error(error.stack);
  }
};

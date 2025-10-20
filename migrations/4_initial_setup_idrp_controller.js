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

    const idrpController = await IDRPController.deployed();

    // Setup roles
    const ADMIN_ROLE = await idrpController.ADMIN_ROLE();
    const OFFICER_ROLE = await idrpController.OFFICER_ROLE();
    const MANAGER_ROLE = await idrpController.MANAGER_ROLE();
    const DIRECTOR_ROLE = await idrpController.DIRECTOR_ROLE();
    const COMMISSIONER_ROLE = await idrpController.COMMISSIONER_ROLE();
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
    await idrpController.setQuorumRules(
      OPERATION.MINT,
      [
        {
          minAmount: 0,
          maxAmount: ONE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE],
        },
        {
          minAmount: ONE_HUNDRED_MILLION,
          maxAmount: FIVE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
        {
          minAmount: FIVE_HUNDRED_MILLION,
          maxAmount: ONE_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        },
        {
          minAmount: ONE_BILLION,
          maxAmount: MaxUint256,
          requiredRoles: [
            OFFICER_ROLE,
            MANAGER_ROLE,
            DIRECTOR_ROLE,
            COMMISSIONER_ROLE,
          ],
        },
      ],
      { from: superAdmin }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for MINT operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.BURN,
      [
        {
          minAmount: 0,
          maxAmount: ONE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE],
        },
        {
          minAmount: ONE_HUNDRED_MILLION,
          maxAmount: FIVE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
        {
          minAmount: FIVE_HUNDRED_MILLION,
          maxAmount: ONE_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        },
        {
          minAmount: ONE_BILLION,
          maxAmount: TEN_BILLION,
          requiredRoles: [
            OFFICER_ROLE,
            MANAGER_ROLE,
            DIRECTOR_ROLE,
            COMMISSIONER_ROLE,
          ],
        },
      ],
      { from: superAdmin }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for BURN operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.FREEZE,
      [
        {
          minAmount: 0,
          maxAmount: FIVE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE],
        },
        {
          minAmount: FIVE_HUNDRED_MILLION,
          maxAmount: ONE_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
        {
          minAmount: ONE_BILLION,
          maxAmount: TEN_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        },
        {
          minAmount: TEN_BILLION,
          maxAmount: MaxUint256,
          requiredRoles: [
            OFFICER_ROLE,
            MANAGER_ROLE,
            DIRECTOR_ROLE,
            COMMISSIONER_ROLE,
          ],
        },
      ],
      { from: superAdmin }
    );
    console.log(
      "[4_setup_idrp_controller] Set quorum rules for FREEZE operation successfully"
    );
    await idrpController.setQuorumRules(
      OPERATION.UNFREEZE,
      [
        {
          minAmount: 0,
          maxAmount: FIVE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE],
        },
        {
          minAmount: FIVE_HUNDRED_MILLION,
          maxAmount: ONE_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
        {
          minAmount: ONE_BILLION,
          maxAmount: TEN_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        },
        {
          minAmount: TEN_BILLION,
          maxAmount: MaxUint256,
          requiredRoles: [
            OFFICER_ROLE,
            MANAGER_ROLE,
            DIRECTOR_ROLE,
            COMMISSIONER_ROLE,
          ],
        },
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
        {
          minAmount: 0,
          maxAmount: MaxUint256,
          requiredRoles: [DIRECTOR_ROLE, MANAGER_ROLE],
        },
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
        {
          minAmount: 0,
          maxAmount: MaxUint256,
          requiredRoles: [
            OFFICER_ROLE,
            MANAGER_ROLE,
            DIRECTOR_ROLE,
            COMMISSIONER_ROLE,
          ],
        },
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
  }
};

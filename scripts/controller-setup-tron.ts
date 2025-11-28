import { tronToHex } from "./utils/addressConverter";
import {
  TRON_COMMISSIONER_ADDRESS,
  TRON_DEPOSITORY_ADDRESS,
  TRON_DIRECTOR_ADDRESS,
  TRON_MANAGER_ADDRESS,
  TRON_OFFICER_ADDRESS,
} from "./utils/constants";
import { delay } from "./utils/misc";

const hre = require("hardhat");
const { deployments, getNamedAccounts } = hre;

(async () => {
  // skip if not tron network
  if (hre.network.name !== "shasta" && hre.network.name !== "tron") {
    console.log("This script is only for TRON networks. Exiting...");
    return;
  }

  console.log({ namedAccounts: await getNamedAccounts() });

  const officerAddress = TRON_OFFICER_ADDRESS;
  console.log("officerAddress", officerAddress);
  const managerAddress = TRON_MANAGER_ADDRESS;
  console.log("managerAddress", managerAddress);
  const directorAddress = TRON_DIRECTOR_ADDRESS;
  console.log("directorAddress", directorAddress);
  const commissionerAddress = TRON_COMMISSIONER_ADDRESS;
  console.log("commissionerAddress", commissionerAddress);

  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const admin = signers[1];
  console.log("admin", admin.address);

  const deploymentsData = await deployments.all();

  // IDRP
  const idrp = await ethers.getContractAt(
    "IDRP",
    deploymentsData["IDRP"].address
  );
  console.log("IDRP token address:", await idrp.getAddress());

  // IDRPController
  const controller = await ethers.getContractAt(
    "IDRPController",
    deploymentsData["IDRPController"].address
  );
  console.log("IDRPController address:", await controller.getAddress());

  try {
    // Set depository address in IDRP token
    const txSetDepository = await idrp
      .connect(admin)
      .setDepositoryWallet(tronToHex(TRON_DEPOSITORY_ADDRESS));
    console.log("Setting depository, tx:", txSetDepository.hash);
    await txSetDepository.wait(1);
    console.log("Depository set to:", await idrp.getDepositoryWallet());
  } catch (error) {
    console.error("Error setting depository address:", error);
    console.log("Continuing with the script...", { res: error.response });
  }

  // Grant controller the necessary roles on IDRP token
  const MINTER_ROLE = await idrp.MINTER_ROLE();
  const PAUSER_ROLE = await idrp.PAUSER_ROLE();
  const FREEZER_ROLE = await idrp.FREEZER_ROLE();
  console.log("IDRP Roles:", { MINTER_ROLE, PAUSER_ROLE, FREEZER_ROLE });

  const txGrantMinter = await idrp
    .connect(admin)
    .grantRole(MINTER_ROLE, controller.getAddress());
  console.log("Granting MINTER_ROLE to controller, tx:", txGrantMinter.hash);
  await txGrantMinter.wait(1);
  console.log(
    "Controller has MINTER_ROLE:",
    await idrp.hasRole(MINTER_ROLE, controller.getAddress())
  );

  const txGrantPauser = await idrp
    .connect(admin)
    .grantRole(PAUSER_ROLE, controller.getAddress());
  console.log("Granting PAUSER_ROLE to controller, tx:", txGrantPauser.hash);
  await txGrantPauser.wait(1);
  console.log(
    "Controller has PAUSER_ROLE:",
    await idrp.hasRole(PAUSER_ROLE, controller.getAddress())
  );

  const txGrantFreezer = await idrp
    .connect(admin)
    .grantRole(FREEZER_ROLE, controller.getAddress());
  console.log("Granting FREEZER_ROLE to controller, tx:", txGrantFreezer.hash);
  await txGrantFreezer.wait(1);
  console.log(
    "Controller has FREEZER_ROLE:",
    await idrp.hasRole(FREEZER_ROLE, controller.getAddress())
  );

  console.log("IDRP token setup completed.");

  // Set up roles for maintainers on IDRPController
  const OFFICER_ROLE = await controller.OFFICER_ROLE();
  const MANAGER_ROLE = await controller.MANAGER_ROLE();
  const DIRECTOR_ROLE = await controller.DIRECTOR_ROLE();
  const COMMISSIONER_ROLE = await controller.COMMISSIONER_ROLE();
  console.log("IDRPController Roles:", {
    OFFICER_ROLE,
    MANAGER_ROLE,
    DIRECTOR_ROLE,
    COMMISSIONER_ROLE,
  });

  const txGrantOfficer = await controller
    .connect(admin)
    .grantRole(OFFICER_ROLE, officerAddress);
  console.log("Granting OFFICER_ROLE, tx:", txGrantOfficer.hash);
  await txGrantOfficer.wait(1);
  console.log(
    "Officer has OFFICER_ROLE:",
    await controller.hasRole(OFFICER_ROLE, officerAddress)
  );

  const txGrantManager = await controller
    .connect(admin)
    .grantRole(MANAGER_ROLE, managerAddress);
  console.log("Granting MANAGER_ROLE, tx:", txGrantManager.hash);
  await txGrantManager.wait(1);
  console.log(
    "Manager has MANAGER_ROLE:",
    await controller.hasRole(MANAGER_ROLE, managerAddress)
  );

  const txGrantDirector = await controller
    .connect(admin)
    .grantRole(DIRECTOR_ROLE, directorAddress);
  console.log("Granting DIRECTOR_ROLE, tx:", txGrantDirector.hash);
  await txGrantDirector.wait(1);
  console.log(
    "Director has DIRECTOR_ROLE:",
    await controller.hasRole(DIRECTOR_ROLE, directorAddress)
  );

  const txGrantCommissioner = await controller
    .connect(admin)
    .grantRole(COMMISSIONER_ROLE, commissionerAddress);
  console.log("Granting COMMISSIONER_ROLE, tx:", txGrantCommissioner.hash);
  await txGrantCommissioner.wait(1);
  console.log(
    "Commissioner has COMMISSIONER_ROLE:",
    await controller.hasRole(COMMISSIONER_ROLE, commissionerAddress)
  );

  console.log("IDRPController setup completed.");

  // Setup quorum rules
  const ONE_HUNDRED_MILLION = ethers.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = ethers.parseUnits("500000000", 6);
  const ONE_BILLION = ethers.parseUnits("1000000000", 6);
  const TEN_BILLION = ethers.parseUnits("10000000000", 6);
  await controller.connect(admin).setQuorumRules(
    0, // OperationType.Mint
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
        maxAmount: ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]
  );

  await delay(1200);
  console.log("wait for 1.2 sec before do another setQuorumRules");

  await controller.connect(admin).setQuorumRules(
    1, // OperationType.Burn
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
    ]
  );

  await delay(1200);
  console.log("wait for 1.2 sec before do another setQuorumRules");

  await controller.connect(admin).setQuorumRules(
    2, // OperationType.Freeze
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
        maxAmount: ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]
  );

  await delay(1200);
  console.log("wait for 1.2 sec before do another setQuorumRules");

  await controller.connect(admin).setQuorumRules(
    3, // OperationType.Unfreeze
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
        maxAmount: ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]
  );

  await delay(1200);
  console.log("wait for 1.2 sec before do another setQuorumRules");

  await controller.connect(admin).setQuorumRules(
    4, // OperationType.Pause
    [
      {
        minAmount: 0,
        maxAmount: ethers.MaxUint256,
        requiredRoles: [DIRECTOR_ROLE, MANAGER_ROLE],
      },
    ]
  );

  await delay(1200);
  console.log("wait for 1.2 sec before do another setQuorumRules");

  await controller.connect(admin).setQuorumRules(
    5, // OperationType.Unpause
    [
      {
        minAmount: 0,
        maxAmount: ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]
  );

  console.log("Quorum rules setup completed.");
  console.log("All done.");
})();

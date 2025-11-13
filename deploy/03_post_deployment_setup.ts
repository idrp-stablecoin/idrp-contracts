import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import {
  TRON_ADMIN_ADDRESS,
  TRON_OFFICER_ADDRESS,
  TRON_MANAGER_ADDRESS,
  TRON_DIRECTOR_ADDRESS,
  TRON_COMMISSIONER_ADDRESS,
  TRON_DEPOSITORY_ADDRESS,
} from "../scripts/utils/constants";
import { hexToTron, tronToHex } from "../scripts/utils/addressConverter";
import { delay } from "../scripts/utils/misc";

const deployFunction: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
) {
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const admin = signers[1];

  // Skip post-deployment setup on EVM networks - only run on TRON
  if (hre.network.name !== "shasta") {
    console.log(`⏭️  Skipping post-deployment setup on ${hre.network.name}\n`);
    return;
  }

  const { deployments } = hre;
  const idrpDeployment = await deployments.get("IDRP");
  const controllerDeployment = await deployments.get("IDRPController");

  // Convert all TRON addresses to hex format
  let adminAddress: string;
  let officerAddress: string;
  let managerAddress: string;
  let directorAddress: string;
  let commissionerAddress: string;
  let idrpAddress: string;
  let controllerAddress: string;
  let depositoryAddress: string;
  if (hre.network.name === "shasta" || hre.network.name === "tron") {
    adminAddress = tronToHex(TRON_ADMIN_ADDRESS);
    officerAddress = tronToHex(TRON_OFFICER_ADDRESS);
    managerAddress = tronToHex(TRON_MANAGER_ADDRESS);
    directorAddress = tronToHex(TRON_DIRECTOR_ADDRESS);
    commissionerAddress = tronToHex(TRON_COMMISSIONER_ADDRESS);
    depositoryAddress = tronToHex(TRON_DEPOSITORY_ADDRESS);
    // Contract addresses from deployments are already in hex format
    idrpAddress = idrpDeployment.address;
    controllerAddress = controllerDeployment.address;
  } else {
    throw new Error("this deployment script is only for TRON networks");
  }

  console.log(`\n🛠️  Setting up roles and permissions on TRON\n`, {
    contract: {
      idrpAddress: idrpAddress,
      controllerAddress: controllerAddress,
    },
    maintainers: {
      adminAddress: await admin.getAddress(),
      officerAddress,
      managerAddress,
      directorAddress,
      commissionerAddress,
    },
  });

  const idrp = await hre.ethers.getContractAt("IDRP", idrpAddress);
  const controller = await hre.ethers.getContractAt(
    "IDRPController",
    controllerAddress
  );
  console.log("Contract instances obtained");
  // Set depository wallet
  console.log(`Setting depository wallet to ${depositoryAddress}`);
  await idrp.connect(admin).setDepositoryWallet(hexToTron(depositoryAddress));
  console.log("Depository wallet set");

  // Grant controller the necessary roles on IDRP token
  console.log(`Granting MINTER_ROLE to controller at ${controllerAddress}`, {
    aaa: await idrp.connect(admin),
    aaaa: await idrp.connect(admin).grantRole,
  });
  await idrp
    .connect(admin)
    .grantRole(await idrp.MINTER_ROLE(), hexToTron(controllerAddress));
  console.log(`Granting FREEZER_ROLE to controller at ${controllerAddress}`);
  await idrp
    .connect(admin)
    .grantRole(await idrp.FREEZER_ROLE(), controllerAddress);
  console.log(`Granting PAUSER_ROLE to controller at ${controllerAddress}`);
  await idrp
    .connect(admin)
    .grantRole(await idrp.PAUSER_ROLE(), controllerAddress);
  console.log("Roles assigned on IDRP token");

  // Setup roles for IDRPController
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("MANAGER_ROLE")
  );
  const DIRECTOR_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("DIRECTOR_ROLE")
  );
  const COMMISSIONER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE")
  );
  console.log(`Setting OFFICER_ROLE for ${officerAddress}`);
  await controller.connect(admin).grantRole(OFFICER_ROLE, officerAddress);
  console.log(`Setting MANAGER_ROLE for ${managerAddress}`);
  await controller.connect(admin).grantRole(MANAGER_ROLE, managerAddress);
  console.log(`Setting DIRECTOR_ROLE for ${directorAddress}`);
  await controller.connect(admin).grantRole(DIRECTOR_ROLE, directorAddress);
  console.log(`Setting COMMISSIONER_ROLE for ${commissionerAddress}`);
  await controller
    .connect(admin)
    .grantRole(COMMISSIONER_ROLE, commissionerAddress);
  console.log("Roles assigned on IDRPController");

  // Set quorum rules
  const ONE_HUNDRED_MILLION = ethers.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = ethers.parseUnits("500000000", 6);
  const ONE_BILLION = ethers.parseUnits("1000000000", 6);
  const TEN_BILLION = ethers.parseUnits("10000000000", 6);
  // Set mint/burn quorum rules
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

  console.log("Quorum rules set up");
  console.log(`\n✓ Post-deployment setup completed\n`);
};

deployFunction.tags = ["PostDeployment"];
deployFunction.dependencies = ["IDRP", "IDRPController"];
deployFunction.id = "post_deployment_setup";

export default deployFunction;

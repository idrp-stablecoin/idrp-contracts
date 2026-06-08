import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import hre from "hardhat";
import {
  ADMIN_ADDRESS,
  COMMISSIONER_ADDRESS,
  DIRECTOR_ADDRESS,
  MANAGER_ADDRESS,
  OFFICER_ADDRESS,
  DEPOSITORY_WALLET_ADDRESS,
} from "./utils/constants";
import { delay } from "./utils/misc";

async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const signers = await ethers.getSigners();
  const admin = signers[1];

  const [
    officerAddress,
    managerAddress,
    directorAddress,
    commissionerAddress,
    depositoryWalletAddress,
  ] = [
    OFFICER_ADDRESS,
    MANAGER_ADDRESS,
    DIRECTOR_ADDRESS,
    COMMISSIONER_ADDRESS,
    DEPOSITORY_WALLET_ADDRESS,
  ];

  console.log("admin", admin.address);
  console.log("approver", {
    officerAddress,
    managerAddress,
    directorAddress,
    commissionerAddress,
  });

  const deployments = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployment/chain-" + networkId + ".json"),
      "utf-8"
    )
  );

  // IDRP token
  const idrp = await ethers.getContractAt("IDRP", deployments["IDRP"]);
  console.log("IDRP token address:", await idrp.getAddress());

  // IDRPController
  const controller = await ethers.getContractAt(
    "IDRPController",
    deployments["IDRPController"]
  );
  console.log("IDRPController address:", await controller.getAddress());

  // Set up roles for IDRPController
  // const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const OFFICER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = ethers.keccak256(
    ethers.toUtf8Bytes("COMMISSIONER_ROLE")
  );

  // Since adminAddress is already has ADMIN_ROLE (at the first of controller deployment), no need to grant it again
  // await controller.connect(admin).grantRole(ADMIN_ROLE, adminAddress);
  await controller.connect(admin).grantRole(OFFICER_ROLE, officerAddress);
  await controller.connect(admin).grantRole(MANAGER_ROLE, managerAddress);
  await controller.connect(admin).grantRole(DIRECTOR_ROLE, directorAddress);
  await controller
    .connect(admin)
    .grantRole(COMMISSIONER_ROLE, commissionerAddress);

  console.log("Roles assigned");

  // Grant controller the necessary roles on IDRP token
  // Since adminAddress is already has DEFAULT_ADMIN_ROLE (at the first of IDRP deployment), no need to grant it again
  // await idrp
  //   .connect(admin)
  //   .grantRole(await idrp.DEFAULT_ADMIN_ROLE(), adminAddress);
  await idrp
    .connect(admin)
    .grantRole(await idrp.MINTER_ROLE(), await controller.getAddress());
  await idrp
    .connect(admin)
    .grantRole(await idrp.FREEZER_ROLE(), await controller.getAddress());
  await idrp
    .connect(admin)
    .grantRole(await idrp.PAUSER_ROLE(), await controller.getAddress());
  console.log("Controller granted roles on IDRP token");

  // Set depository wallet
  await idrp.connect(admin).setDepositoryWallet(depositoryWalletAddress);
  console.log("Depository wallet set to:", depositoryWalletAddress);

  // Set quorum rules
  const ONE_HUNDRED_MILLION = ethers.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = ethers.parseUnits("500000000", 6);
  const ONE_BILLION = ethers.parseUnits("1000000000", 6);
  const TEN_BILLION = ethers.parseUnits("10000000000", 6);

  console.log("Setting quorum rules...", {
    ONE_HUNDRED_MILLION: ONE_HUNDRED_MILLION.toString(),
    FIVE_HUNDRED_MILLION: FIVE_HUNDRED_MILLION.toString(),
    ONE_BILLION: ONE_BILLION.toString(),
    TEN_BILLION: TEN_BILLION.toString(),
  });

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
  console.log("Setup complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

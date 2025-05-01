import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  console.log("deployer", deployer.address);

  const [
    officerAddress,
    managerAddress,
    directorAddress,
    commissionerAddress,
    adminAddress,
  ] = [
    "0x99A0AD5DF1651D8812B0b4Ca5102ad060C4DC2d3",
    "0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761",
    "0x5B2A48685a89458ECbaB3AEC56923e128f441995",
    "0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed",
    "0x0FC4CBd7f60E0BE5FeaCFAB6B8818F88763f9640",
  ];

  const deployments = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployment/chain-17000.json"),
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
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const OFFICER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = ethers.keccak256(
    ethers.toUtf8Bytes("COMMISSIONER_ROLE")
  );

  await controller.connect(deployer).grantRole(ADMIN_ROLE, adminAddress);
  await controller.connect(deployer).grantRole(OFFICER_ROLE, officerAddress);
  await controller.connect(deployer).grantRole(MANAGER_ROLE, managerAddress);
  await controller.connect(deployer).grantRole(DIRECTOR_ROLE, directorAddress);
  await controller
    .connect(deployer)
    .grantRole(COMMISSIONER_ROLE, commissionerAddress);

  console.log("Roles assigned");

  // Grant controller the necessary roles on IDRP token
  await idrp
    .connect(deployer)
    .grantRole(await idrp.DEFAULT_ADMIN_ROLE(), adminAddress);
  await idrp
    .connect(deployer)
    .grantRole(await idrp.MINTER_ROLE(), await controller.getAddress());
  await idrp
    .connect(deployer)
    .grantRole(await idrp.FREEZER_ROLE(), await controller.getAddress());
  console.log("Controller granted roles on IDRP token");

  // Set quorum rules
  const ONE_HUNDRED_MILLION = ethers.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = ethers.parseUnits("500000000", 6);
  const ONE_BILLION = ethers.parseUnits("1000000000", 6);
  const TEN_BILLION = ethers.parseUnits("10000000000", 6);

  // Set mint/burn quorum rules
  await controller.connect(deployer).setQuorumRules(
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
  await controller.connect(deployer).setQuorumRules(
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
  await controller.connect(deployer).setQuorumRules(
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

  await controller.connect(deployer).setQuorumRules(
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

  await controller.connect(deployer).setQuorumRules(
    4, // OperationType.Pause
    [
      {
        minAmount: 0,
        maxAmount: ethers.MaxUint256,
        requiredRoles: [DIRECTOR_ROLE, MANAGER_ROLE],
      },
    ]
  );

  await controller.connect(deployer).setQuorumRules(
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

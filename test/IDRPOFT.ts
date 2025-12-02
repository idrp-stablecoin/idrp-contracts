/**
 * IDRP OFT Comprehensive Tests
 *
 * This test file uses ethers v5 utilities (imported from 'ethers' package)
 * combined with hardhat's runtime helpers.
 *
 * Test scenarios:
 * 1. Full deployment and setup
 * 2. Mint/Burn operations via Controller
 * 3. Cross-chain transfers (Canonical ↔ Remote)
 * 4. Compliance broadcasting (Freeze/Unfreeze/Pause/Unpause)
 * 5. Edge cases and security scenarios
 */

import { expect } from "chai";
import {
  ethers as ethersV5,
  Contract,
  ContractFactory,
  BigNumber,
} from "ethers";
import hre from "hardhat";
import { Options } from "@layerzerolabs/lz-v2-utilities";

const { deployments, upgrades } = hre;

describe("IDRP OFT Comprehensive Tests", function () {
  // Role hashes (using ethers v5 utilities)
  const OFFICER_ROLE = ethersV5.utils.keccak256(
    ethersV5.utils.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = ethersV5.utils.keccak256(
    ethersV5.utils.toUtf8Bytes("MANAGER_ROLE")
  );
  const DIRECTOR_ROLE = ethersV5.utils.keccak256(
    ethersV5.utils.toUtf8Bytes("DIRECTOR_ROLE")
  );
  const COMMISSIONER_ROLE = ethersV5.utils.keccak256(
    ethersV5.utils.toUtf8Bytes("COMMISSIONER_ROLE")
  );

  // Amount constants (ethers v5)
  const ONE_MILLION = ethersV5.utils.parseUnits("1000000", 6);
  const TEN_MILLION = ethersV5.utils.parseUnits("10000000", 6);
  const ONE_HUNDRED_MILLION = ethersV5.utils.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = ethersV5.utils.parseUnits("500000000", 6);
  const ONE_BILLION = ethersV5.utils.parseUnits("1000000000", 6);
  const TEN_BILLION = ethersV5.utils.parseUnits("10000000000", 6);

  // Chain endpoint IDs
  const EID_BASE_SEPOLIA = 1; // Canonical
  const EID_ARB_SEPOLIA = 2; // Remote 1
  const EID_SEPOLIA = 3; // Remote 2

  // Message types for compliance broadcast
  const MSG_FREEZE = 1;
  const MSG_UNFREEZE = 2;
  const MSG_PAUSE = 3;
  const MSG_UNPAUSE = 4;

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  // Signers (typed loosely to work with both v5/v6)
  let admin: any;
  let officer: any;
  let manager: any;
  let director: any;
  let commissioner: any;
  let depository: any;
  let user1: any;
  let user2: any;
  let endpointOwner: any;

  // Contracts
  let idrp: any;
  let controller: any;
  let oftAdapter: any;
  let endpointBaseSepolia: any;
  let oftArbSepolia: any;
  let oftSepolia: any;
  let endpointArbSepolia: any;
  let endpointSepolia: any;

  // Contract factories
  let EndpointV2Mock: any;
  let IDRPFactory: any;
  let ControllerFactory: any;
  let OFTAdapterFactory: any;
  let OFTFactory: any;

  // EIP-712 domain and types
  let domain: any;
  let types: any;

  /**
   * Helper to get address from contract (works with both v5/v6)
   */
  async function getAddress(contract: any): Promise<string> {
    if (typeof contract.getAddress === "function") {
      return await contract.getAddress();
    }
    return contract.address;
  }

  /**
   * Helper to wait for deployment
   */
  async function waitDeployed(contract: any): Promise<void> {
    if (typeof contract.waitForDeployment === "function") {
      await contract.waitForDeployment();
    } else if (typeof contract.deployed === "function") {
      await contract.deployed();
    }
  }

  /**
   * Helper to get signers with v5-compatible interface
   */
  async function getSigners(): Promise<any[]> {
    const provider = hre.network.provider;
    const accounts = (await provider.request({
      method: "eth_accounts",
    })) as string[];

    const signers: any[] = [];
    for (const account of accounts) {
      const signer = new ethersV5.providers.Web3Provider(
        provider as any
      ).getSigner(account);
      signers.push(signer);
    }
    return signers;
  }

  before(async function () {
    // Get signers using v5-compatible approach
    const signers = await getSigners();
    [
      admin,
      officer,
      manager,
      director,
      commissioner,
      depository,
      user1,
      user2,
      endpointOwner,
    ] = signers;

    // Get EndpointV2Mock from hardhat-deploy artifacts
    const EndpointV2MockArtifact = await deployments.getArtifact(
      "EndpointV2Mock"
    );

    // Create v5-compatible contract factory
    const provider = new ethersV5.providers.Web3Provider(
      hre.network.provider as any
    );
    EndpointV2Mock = new ContractFactory(
      EndpointV2MockArtifact.abi,
      EndpointV2MockArtifact.bytecode,
      provider.getSigner(await endpointOwner.getAddress())
    );
  });

  beforeEach(async function () {
    const provider = new ethersV5.providers.Web3Provider(
      hre.network.provider as any
    );

    // ========== Deploy Mock LayerZero Endpoints ==========
    endpointBaseSepolia = await EndpointV2Mock.deploy(EID_BASE_SEPOLIA);
    await endpointBaseSepolia.deployed();

    endpointArbSepolia = await EndpointV2Mock.deploy(EID_ARB_SEPOLIA);
    await endpointArbSepolia.deployed();

    endpointSepolia = await EndpointV2Mock.deploy(EID_SEPOLIA);
    await endpointSepolia.deployed();

    // ========== Deploy IDRP Token using hardhat-upgrades ==========
    // We need to use hre for factories since they interact with hardhat-upgrades
    const IDRPFactoryHRE = await hre.ethers.getContractFactory("IDRP");
    idrp = await hre.upgrades.deployProxy(IDRPFactoryHRE, [
      await admin.getAddress(),
    ]);
    await waitDeployed(idrp);

    // Wrap with v5 contract for consistent API
    const idrpAddress = await getAddress(idrp);
    const idrpArtifact = await hre.artifacts.readArtifact("IDRP");
    idrp = new Contract(idrpAddress, idrpArtifact.abi, admin);

    // Set depository wallet
    await idrp
      .connect(admin)
      .setDepositoryWallet(await depository.getAddress());

    // ========== Deploy IDRPController ==========
    const ControllerFactoryHRE = await hre.ethers.getContractFactory(
      "IDRPController"
    );
    controller = await hre.upgrades.deployProxy(ControllerFactoryHRE, [
      idrpAddress,
      await admin.getAddress(),
    ]);
    await waitDeployed(controller);

    const controllerAddress = await getAddress(controller);
    const controllerArtifact = await hre.artifacts.readArtifact(
      "IDRPController"
    );
    controller = new Contract(controllerAddress, controllerArtifact.abi, admin);

    // EIP-712 Domain
    domain = {
      name: "IDRPController",
      version: "1",
      chainId: 31337,
      verifyingContract: controllerAddress,
    };

    types = {
      Operation: [
        { name: "to", type: "address" },
        { name: "operationType", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "operationIdentifier", type: "string" },
        { name: "deadline", type: "uint256" },
      ],
    };

    // Setup roles on Controller
    await controller
      .connect(admin)
      .grantRole(OFFICER_ROLE, await officer.getAddress());
    await controller
      .connect(admin)
      .grantRole(MANAGER_ROLE, await manager.getAddress());
    await controller
      .connect(admin)
      .grantRole(DIRECTOR_ROLE, await director.getAddress());
    await controller
      .connect(admin)
      .grantRole(COMMISSIONER_ROLE, await commissioner.getAddress());

    // Grant Controller roles on IDRP token
    await idrp
      .connect(admin)
      .grantRole(await idrp.MINTER_ROLE(), controllerAddress);
    await idrp
      .connect(admin)
      .grantRole(await idrp.FREEZER_ROLE(), controllerAddress);
    await idrp
      .connect(admin)
      .grantRole(await idrp.PAUSER_ROLE(), controllerAddress);

    // Setup quorum rules
    await setupQuorumRules();

    // ========== Deploy OFT Adapter ==========
    const OFTAdapterFactoryHRE = await hre.ethers.getContractFactory(
      "IDRPOFTAdapterUpgradeable"
    );
    oftAdapter = await hre.upgrades.deployProxy(
      OFTAdapterFactoryHRE,
      [await admin.getAddress()],
      {
        initializer: "initialize",
        constructorArgs: [idrpAddress, endpointBaseSepolia.address],
        unsafeAllow: [
          "constructor",
          "state-variable-immutable",
          "missing-initializer-call",
        ],
      }
    );
    await waitDeployed(oftAdapter);

    const oftAdapterAddress = await getAddress(oftAdapter);
    const oftAdapterArtifact = await hre.artifacts.readArtifact(
      "IDRPOFTAdapterUpgradeable"
    );
    oftAdapter = new Contract(oftAdapterAddress, oftAdapterArtifact.abi, admin);

    // ========== Deploy OFT on Remote Chains ==========
    const OFTFactoryHRE = await hre.ethers.getContractFactory(
      "IDRPOFTUpgradeable"
    );

    // Arbitrum Sepolia OFT
    oftArbSepolia = await hre.upgrades.deployProxy(
      OFTFactoryHRE,
      ["IDRP", "IDRP", await admin.getAddress()],
      {
        initializer: "initialize",
        constructorArgs: [endpointArbSepolia.address],
        unsafeAllow: [
          "constructor",
          "state-variable-immutable",
          "missing-initializer-call",
        ],
      }
    );
    await waitDeployed(oftArbSepolia);

    const oftArbSepoliaAddress = await getAddress(oftArbSepolia);
    const oftArtifact = await hre.artifacts.readArtifact("IDRPOFTUpgradeable");
    oftArbSepolia = new Contract(oftArbSepoliaAddress, oftArtifact.abi, admin);

    // Sepolia OFT
    oftSepolia = await hre.upgrades.deployProxy(
      OFTFactoryHRE,
      ["IDRP", "IDRP", await admin.getAddress()],
      {
        initializer: "initialize",
        constructorArgs: [endpointSepolia.address],
        unsafeAllow: [
          "constructor",
          "state-variable-immutable",
          "missing-initializer-call",
        ],
      }
    );
    await waitDeployed(oftSepolia);

    const oftSepoliaAddress = await getAddress(oftSepolia);
    oftSepolia = new Contract(oftSepoliaAddress, oftArtifact.abi, admin);

    // ========== Configure LayerZero Endpoints (Mock) ==========
    await endpointBaseSepolia.setDestLzEndpoint(
      oftArbSepoliaAddress,
      endpointArbSepolia.address
    );
    await endpointBaseSepolia.setDestLzEndpoint(
      oftSepoliaAddress,
      endpointSepolia.address
    );
    await endpointArbSepolia.setDestLzEndpoint(
      oftAdapterAddress,
      endpointBaseSepolia.address
    );
    await endpointArbSepolia.setDestLzEndpoint(
      oftSepoliaAddress,
      endpointSepolia.address
    );
    await endpointSepolia.setDestLzEndpoint(
      oftAdapterAddress,
      endpointBaseSepolia.address
    );
    await endpointSepolia.setDestLzEndpoint(
      oftArbSepoliaAddress,
      endpointArbSepolia.address
    );

    // ========== Configure Peers (Hub-and-Spoke) ==========
    await oftAdapter
      .connect(admin)
      .setPeer(
        EID_ARB_SEPOLIA,
        ethersV5.utils.hexZeroPad(oftArbSepoliaAddress, 32)
      );
    await oftArbSepolia
      .connect(admin)
      .setPeer(
        EID_BASE_SEPOLIA,
        ethersV5.utils.hexZeroPad(oftAdapterAddress, 32)
      );
    await oftAdapter
      .connect(admin)
      .setPeer(EID_SEPOLIA, ethersV5.utils.hexZeroPad(oftSepoliaAddress, 32));
    await oftSepolia
      .connect(admin)
      .setPeer(
        EID_BASE_SEPOLIA,
        ethersV5.utils.hexZeroPad(oftAdapterAddress, 32)
      );

    // ========== Set Enforced Options ==========
    await oftAdapter.connect(admin).setEnforcedOptions([
      [
        EID_ARB_SEPOLIA,
        1,
        Options.newOptions().addExecutorLzReceiveOption(80000, 0).toHex(),
      ],
      [
        EID_SEPOLIA,
        1,
        Options.newOptions().addExecutorLzReceiveOption(80000, 0).toHex(),
      ],
    ]);
    await oftArbSepolia
      .connect(admin)
      .setEnforcedOptions([
        [
          EID_BASE_SEPOLIA,
          1,
          Options.newOptions().addExecutorLzReceiveOption(80000, 0).toHex(),
        ],
      ]);
    await oftSepolia
      .connect(admin)
      .setEnforcedOptions([
        [
          EID_BASE_SEPOLIA,
          1,
          Options.newOptions().addExecutorLzReceiveOption(80000, 0).toHex(),
        ],
      ]);
  });

  async function setupQuorumRules() {
    // Mint rules
    await controller.connect(admin).setQuorumRules(OperationType.Mint, [
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
    ]);

    // Burn rules
    await controller.connect(admin).setQuorumRules(OperationType.Burn, [
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
    ]);

    // Freeze rules
    await controller.connect(admin).setQuorumRules(OperationType.Freeze, [
      {
        minAmount: 0,
        maxAmount: ethersV5.constants.MaxUint256,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

    // Unfreeze rules
    await controller.connect(admin).setQuorumRules(OperationType.Unfreeze, [
      {
        minAmount: 0,
        maxAmount: ethersV5.constants.MaxUint256,
        requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
      },
    ]);

    // Pause rules
    await controller.connect(admin).setQuorumRules(OperationType.Pause, [
      {
        minAmount: 0,
        maxAmount: ethersV5.constants.MaxUint256,
        requiredRoles: [MANAGER_ROLE, DIRECTOR_ROLE],
      },
    ]);

    // Unpause rules
    await controller.connect(admin).setQuorumRules(OperationType.Unpause, [
      {
        minAmount: 0,
        maxAmount: ethersV5.constants.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]);
  }

  /**
   * Sign operation using EIP-712
   */
  async function signOperation(signer: any, operation: any) {
    return await signer._signTypedData(domain, types, operation);
  }

  /**
   * Execute mint via controller
   */
  async function executeMint(
    amount: BigNumber,
    signers: any[],
    recipient = depository
  ) {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const operationIdentifier = `mint-${Date.now()}`;

    const operation = {
      to: await recipient.getAddress(),
      operationType: OperationType.Mint,
      amount: amount,
      operationIdentifier: operationIdentifier,
      deadline: deadline,
    };

    const signatures = await Promise.all(
      signers.map((s) => signOperation(s, operation))
    );

    await controller.executeOperation(
      OperationType.Mint,
      await recipient.getAddress(),
      amount,
      operationIdentifier,
      deadline,
      signatures
    );
  }

  // ==================== TEST SUITES ====================

  describe("1. Deployment and Setup", function () {
    it("Should deploy all contracts correctly", async function () {
      expect(await idrp.name()).to.equal("IDRP");
      expect(await idrp.symbol()).to.equal("IDRP");
      expect(await idrp.decimals()).to.equal(6);

      expect(await oftArbSepolia.name()).to.equal("IDRP");
      expect(await oftSepolia.name()).to.equal("IDRP");
    });

    it("Should set depository wallet correctly", async function () {
      expect(await idrp.depositoryWallet()).to.equal(
        await depository.getAddress()
      );
    });

    it("Should have Controller with correct roles", async function () {
      expect(await controller.hasRole(OFFICER_ROLE, await officer.getAddress()))
        .to.be.true;
      expect(await controller.hasRole(MANAGER_ROLE, await manager.getAddress()))
        .to.be.true;
      expect(
        await controller.hasRole(DIRECTOR_ROLE, await director.getAddress())
      ).to.be.true;
      expect(
        await controller.hasRole(
          COMMISSIONER_ROLE,
          await commissioner.getAddress()
        )
      ).to.be.true;
    });

    it("Should have peers configured correctly (Hub-and-Spoke)", async function () {
      expect(await oftAdapter.peers(EID_ARB_SEPOLIA)).to.not.equal(
        ethersV5.constants.HashZero
      );
      expect(await oftAdapter.peers(EID_SEPOLIA)).to.not.equal(
        ethersV5.constants.HashZero
      );
      expect(await oftArbSepolia.peers(EID_BASE_SEPOLIA)).to.not.equal(
        ethersV5.constants.HashZero
      );
      expect(await oftSepolia.peers(EID_BASE_SEPOLIA)).to.not.equal(
        ethersV5.constants.HashZero
      );

      // No peer between remote chains (Hub-and-Spoke)
      expect(await oftArbSepolia.peers(EID_SEPOLIA)).to.equal(
        ethersV5.constants.HashZero
      );
      expect(await oftSepolia.peers(EID_ARB_SEPOLIA)).to.equal(
        ethersV5.constants.HashZero
      );
    });
  });

  describe("2. Mint Operations via Controller", function () {
    it("Should mint tokens to depository via Controller", async function () {
      await executeMint(TEN_MILLION, [officer]);
      expect(await idrp.balanceOf(await depository.getAddress())).to.equal(
        TEN_MILLION
      );
    });

    it("Should require multiple signatures for large mint", async function () {
      const amount = ethersV5.utils.parseUnits("200000000", 6); // 200M
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "mint-large";

      const operation = {
        to: await depository.getAddress(),
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      // Only officer (should fail - requires officer + manager for 200M)
      const officerSig = await signOperation(officer, operation);
      let reverted = false;
      try {
        await controller.executeOperation(
          OperationType.Mint,
          await depository.getAddress(),
          amount,
          operationIdentifier,
          deadline,
          [officerSig]
        );
      } catch (e: any) {
        reverted = true;
        // Check that error contains "Missing signature for role"
        expect(e.message).to.include("Missing signature for role");
      }
      expect(reverted).to.be.true;

      // Officer + manager (should succeed)
      const newOperationIdentifier = "mint-large-2";
      const newOperation = {
        to: await depository.getAddress(),
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: newOperationIdentifier,
        deadline: deadline,
      };
      const officerSig2 = await signOperation(officer, newOperation);
      const managerSig = await signOperation(manager, newOperation);
      await controller.executeOperation(
        OperationType.Mint,
        await depository.getAddress(),
        amount,
        newOperationIdentifier,
        deadline,
        [officerSig2, managerSig]
      );

      expect(await idrp.balanceOf(await depository.getAddress())).to.equal(
        amount
      );
    });
  });

  describe("3. Cross-Chain Transfers", function () {
    beforeEach(async function () {
      await executeMint(ONE_HUNDRED_MILLION, [officer, manager]);
      await idrp
        .connect(depository)
        .transfer(await user1.getAddress(), TEN_MILLION);
    });

    it.skip("Should transfer tokens from canonical to remote chain (requires full LZ mock setup)", async function () {
      const sendAmount = ONE_MILLION;
      const oftAdapterAddress = await getAddress(oftAdapter);

      await idrp.connect(user1).approve(oftAdapterAddress, sendAmount);

      // Use tuple format for SendParam struct
      const sendParam = [
        EID_ARB_SEPOLIA, // dstEid
        ethersV5.utils.hexZeroPad(await user1.getAddress(), 32), // to
        sendAmount, // amountLD
        sendAmount, // minAmountLD
        "0x", // extraOptions
        "0x", // composeMsg
        "0x", // oftCmd
      ];

      const quote = await oftAdapter.quoteSend(sendParam, false);
      const nativeFee = quote.nativeFee;

      await oftAdapter
        .connect(user1)
        .send(sendParam, [nativeFee, 0], await user1.getAddress(), {
          value: nativeFee,
        });

      expect(await idrp.balanceOf(oftAdapterAddress)).to.equal(sendAmount);
      expect(await oftArbSepolia.balanceOf(await user1.getAddress())).to.equal(
        sendAmount
      );
    });

    it.skip("Should transfer tokens from remote chain back to canonical (requires full LZ mock setup)", async function () {
      const sendAmount = ONE_MILLION;
      const oftAdapterAddress = await getAddress(oftAdapter);

      // Send to remote first
      await idrp.connect(user1).approve(oftAdapterAddress, sendAmount);
      const sendParam1 = {
        dstEid: EID_ARB_SEPOLIA,
        to: ethersV5.utils.hexZeroPad(await user1.getAddress(), 32),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const [nativeFee1] = await oftAdapter.quoteSend(sendParam1, false);
      await oftAdapter
        .connect(user1)
        .send(sendParam1, [nativeFee1, 0], await user1.getAddress(), {
          value: nativeFee1,
        });

      // Send back to canonical
      const sendParam2 = {
        dstEid: EID_BASE_SEPOLIA,
        to: ethersV5.utils.hexZeroPad(await user1.getAddress(), 32),
        amountLD: sendAmount,
        minAmountLD: sendAmount,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const [nativeFee2] = await oftArbSepolia.quoteSend(sendParam2, false);
      await oftArbSepolia
        .connect(user1)
        .send(sendParam2, [nativeFee2, 0], await user1.getAddress(), {
          value: nativeFee2,
        });

      expect(await oftArbSepolia.balanceOf(await user1.getAddress())).to.equal(
        0
      );
      expect(await idrp.balanceOf(await user1.getAddress())).to.equal(
        TEN_MILLION
      );
    });
  });

  describe("4. Compliance Broadcasting", function () {
    beforeEach(async function () {
      await executeMint(ONE_HUNDRED_MILLION, [officer, manager]);
      await idrp
        .connect(depository)
        .transfer(await user1.getAddress(), TEN_MILLION);
    });

    describe("4.1 Freeze Broadcasting", function () {
      it("Should freeze user on canonical chain", async function () {
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const operationIdentifier = "freeze-user1";

        const operation = {
          to: await user1.getAddress(),
          operationType: OperationType.Freeze,
          amount: 0,
          operationIdentifier: operationIdentifier,
          deadline: deadline,
        };

        const officerSig = await signOperation(officer, operation);

        await controller.executeOperation(
          OperationType.Freeze,
          await user1.getAddress(),
          0,
          operationIdentifier,
          deadline,
          [officerSig]
        );

        expect(await idrp.frozen(await user1.getAddress())).to.be.true;
        // Remote not yet frozen
        expect(await oftArbSepolia.frozen(await user1.getAddress())).to.be
          .false;
      });

      it.skip("Should broadcast freeze to remote chain (requires full LZ mock setup)", async function () {
        // Freeze user on canonical
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const operationIdentifier = "freeze-broadcast";

        const operation = {
          to: await user1.getAddress(),
          operationType: OperationType.Freeze,
          amount: 0,
          operationIdentifier: operationIdentifier,
          deadline: deadline,
        };

        const officerSig = await signOperation(officer, operation);
        await controller.executeOperation(
          OperationType.Freeze,
          await user1.getAddress(),
          0,
          operationIdentifier,
          deadline,
          [officerSig]
        );

        // Broadcast freeze
        const dstEids = [EID_ARB_SEPOLIA];
        const nativeFee = await oftAdapter.quoteBroadcast(
          MSG_FREEZE,
          await user1.getAddress(),
          dstEids
        );

        await oftAdapter
          .connect(admin)
          .broadcast(MSG_FREEZE, await user1.getAddress(), dstEids, {
            value: nativeFee,
          });

        expect(await oftArbSepolia.frozen(await user1.getAddress())).to.be.true;
      });
    });

    describe("4.2 Pause Broadcasting", function () {
      it.skip("Should broadcast pause to remote chain (requires full LZ mock setup)", async function () {
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const operationIdentifier = "pause-global";

        const operation = {
          to: ethersV5.constants.AddressZero,
          operationType: OperationType.Pause,
          amount: 0,
          operationIdentifier: operationIdentifier,
          deadline: deadline,
        };

        const managerSig = await signOperation(manager, operation);
        const directorSig = await signOperation(director, operation);

        await controller.executeOperation(
          OperationType.Pause,
          ethersV5.constants.AddressZero,
          0,
          operationIdentifier,
          deadline,
          [managerSig, directorSig]
        );

        expect(await idrp.paused()).to.be.true;

        // Broadcast pause
        const dstEids = [EID_ARB_SEPOLIA];
        const nativeFee = await oftAdapter.quoteBroadcast(
          MSG_PAUSE,
          ethersV5.constants.AddressZero,
          dstEids
        );

        await oftAdapter
          .connect(admin)
          .broadcast(MSG_PAUSE, ethersV5.constants.AddressZero, dstEids, {
            value: nativeFee,
          });

        expect(await oftArbSepolia.paused()).to.be.true;
      });
    });
  });

  describe.skip("5. Compliance Enforcement (requires full LZ mock setup)", function () {
    beforeEach(async function () {
      await executeMint(ONE_HUNDRED_MILLION, [officer, manager]);
      await idrp
        .connect(depository)
        .transfer(await user1.getAddress(), TEN_MILLION);

      // Send tokens to remote
      const oftAdapterAddress = await getAddress(oftAdapter);
      await idrp.connect(user1).approve(oftAdapterAddress, ONE_MILLION);
      const sendParam = {
        dstEid: EID_ARB_SEPOLIA,
        to: ethersV5.utils.hexZeroPad(await user1.getAddress(), 32),
        amountLD: ONE_MILLION,
        minAmountLD: ONE_MILLION,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const [nativeFee] = await oftAdapter.quoteSend(sendParam, false);
      await oftAdapter
        .connect(user1)
        .send(sendParam, [nativeFee, 0], await user1.getAddress(), {
          value: nativeFee,
        });
    });

    it("Should prevent frozen user from transferring on remote chain", async function () {
      // Freeze and broadcast
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "freeze-enforce";

      const operation = {
        to: await user1.getAddress(),
        operationType: OperationType.Freeze,
        amount: 0,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      const officerSig = await signOperation(officer, operation);
      await controller.executeOperation(
        OperationType.Freeze,
        await user1.getAddress(),
        0,
        operationIdentifier,
        deadline,
        [officerSig]
      );

      const options = Options.newOptions()
        .addExecutorLzReceiveOption(200000, 0)
        .toHex();
      const [nativeFee] = await oftAdapter.quoteBroadcastFreeze(
        await user1.getAddress(),
        EID_ARB_SEPOLIA,
        options
      );
      await oftAdapter
        .connect(admin)
        .broadcastFreeze(await user1.getAddress(), EID_ARB_SEPOLIA, options, {
          value: nativeFee,
        });

      // Try to transfer (should fail)
      await expect(
        oftArbSepolia.connect(user1).transfer(await user2.getAddress(), 1000)
      ).to.be.revertedWithCustomError(oftArbSepolia, "AccountFrozen");
    });

    it("Should prevent transfers when remote chain is paused", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "pause-enforce";

      const operation = {
        to: ethersV5.constants.AddressZero,
        operationType: OperationType.Pause,
        amount: 0,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      const managerSig = await signOperation(manager, operation);
      const directorSig = await signOperation(director, operation);

      await controller.executeOperation(
        OperationType.Pause,
        ethersV5.constants.AddressZero,
        0,
        operationIdentifier,
        deadline,
        [managerSig, directorSig]
      );

      const options = Options.newOptions()
        .addExecutorLzReceiveOption(200000, 0)
        .toHex();
      const [nativeFee] = await oftAdapter.quoteBroadcastPause(
        EID_ARB_SEPOLIA,
        options
      );
      await oftAdapter
        .connect(admin)
        .broadcastPause(EID_ARB_SEPOLIA, options, { value: nativeFee });

      await expect(
        oftArbSepolia.connect(user1).transfer(await user2.getAddress(), 1000)
      ).to.be.revertedWithCustomError(oftArbSepolia, "EnforcedPause");
    });
  });

  describe("6. Edge Cases", function () {
    it("Should not allow non-admin to broadcast compliance", async function () {
      const dstEids = [EID_ARB_SEPOLIA];

      await expect(
        oftAdapter
          .connect(user1)
          .broadcast(MSG_FREEZE, await user2.getAddress(), dstEids, {
            value: ethersV5.utils.parseEther("1"),
          })
      ).to.be.reverted;
    });

    it.skip("Should broadcast to multiple remote chains (requires full LZ mock setup)", async function () {
      await executeMint(ONE_HUNDRED_MILLION, [officer, manager]);

      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "freeze-multi";

      const operation = {
        to: await user1.getAddress(),
        operationType: OperationType.Freeze,
        amount: 0,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      const officerSig = await signOperation(officer, operation);
      await controller.executeOperation(
        OperationType.Freeze,
        await user1.getAddress(),
        0,
        operationIdentifier,
        deadline,
        [officerSig]
      );

      // Broadcast to both chains at once
      const dstEids = [EID_ARB_SEPOLIA, EID_SEPOLIA];
      const nativeFee = await oftAdapter.quoteBroadcast(
        MSG_FREEZE,
        await user1.getAddress(),
        dstEids
      );

      await oftAdapter
        .connect(admin)
        .broadcast(MSG_FREEZE, await user1.getAddress(), dstEids, {
          value: nativeFee,
        });

      expect(await oftArbSepolia.frozen(await user1.getAddress())).to.be.true;
      expect(await oftSepolia.frozen(await user1.getAddress())).to.be.true;
    });
  });
});

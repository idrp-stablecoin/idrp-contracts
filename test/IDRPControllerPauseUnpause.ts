import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController - Pause and Unpause", function () {
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
  const ADMIN_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("ADMIN_ROLE"));

  // This needs to match the enum in the contract
  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  async function deployFixture() {
    const [admin, officer, manager, director, commissioner, user, depository] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    // Set depositoryWallet
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controller.waitForDeployment();

    // Domain for EIP-712
    const domain = {
      name: "IDRPController",
      version: "1",
      chainId: 31337,
      verifyingContract: await controller.getAddress(),
    };

    const types = {
      Operation: [
        { name: "to", type: "address" },
        { name: "operationType", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    // Set up roles
    await controller.grantRole(OFFICER_ROLE, officer.address);
    await controller.grantRole(MANAGER_ROLE, manager.address);
    await controller.grantRole(DIRECTOR_ROLE, director.address);
    await controller.grantRole(COMMISSIONER_ROLE, commissioner.address);

    await idrp.grantRole(await idrp.MINTER_ROLE(), controller.getAddress());
    await idrp.grantRole(await idrp.FREEZER_ROLE(), controller.getAddress());
    await idrp.grantRole(await idrp.PAUSER_ROLE(), controller.getAddress());

    // Set quorum rules for Pause
    await controller.setQuorumRules(OperationType.Pause, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [MANAGER_ROLE, DIRECTOR_ROLE],
      },
    ]);

    // Set quorum rules for Unpause - Adding all roles here even though the actual logic
    // uses specialized verification with OR logic in the contract
    await controller.setQuorumRules(OperationType.Unpause, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]);

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      director,
      commissioner,
      user,
      depository,
      domain,
      types,
    };
  }

  describe("Pause Operation", function () {
    it("Should execute pause operation with manager and director signatures", async function () {
      const { controller, idrp, manager, director, domain, types } =
        await loadFixture(deployFixture);

      // Verify token is not paused initially
      expect(await idrp.paused()).to.be.false;

      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Create pause operation data
      const pauseOperation = {
        to: hre.ethers.ZeroAddress, // Address doesn't matter for pause
        operationType: OperationType.Pause,
        amount: 0, // Amount doesn't matter for pause
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      // Get required signatures
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        pauseOperation
      );
      const directorSignature = await director.signTypedData(
        domain,
        types,
        pauseOperation
      );

      // Execute pause operation
      await controller.executeOperation(
        pauseOperation.operationType,
        pauseOperation.to,
        pauseOperation.amount,
        pauseOperation.deadline,
        [managerSignature, directorSignature]
      );

      // Verify token is now paused
      expect(await idrp.paused()).to.be.true;
    });

    it("Should fail pause operation without required signatures", async function () {
      const { controller, idrp, manager, domain, types } = await loadFixture(
        deployFixture
      );

      // Verify token is not paused initially
      expect(await idrp.paused()).to.be.false;

      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Create pause operation data
      const pauseOperation = {
        to: hre.ethers.ZeroAddress, // Address doesn't matter for pause
        operationType: OperationType.Pause,
        amount: 0, // Amount doesn't matter for pause
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      // Get only manager signature (missing director)
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        pauseOperation
      );

      // Attempt pause operation, should fail
      let failedAsExpected = false;
      try {
        await controller.executeOperation(
          pauseOperation.operationType,
          pauseOperation.to,
          pauseOperation.amount,
          pauseOperation.deadline,
          [managerSignature]
        );
      } catch (error) {
        failedAsExpected = true;
      }

      // Verify operation failed and token is still not paused
      expect(failedAsExpected).to.be.true;
      expect(await idrp.paused()).to.be.false;
    });
  });

  describe("Unpause Operation", function () {
    it("Should execute unpause operation with officer+manager+director signatures", async function () {
      const { controller, idrp, officer, manager, director, domain, types } =
        await loadFixture(deployFixture);

      // First pause the token
      const pauseDeadline = Math.floor(Date.now() / 1000) + 3600;
      const pauseOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Pause,
        amount: 0,
        nonce: await controller.nonce(),
        deadline: pauseDeadline,
      };

      const managerPauseSignature = await manager.signTypedData(
        domain,
        types,
        pauseOperation
      );
      const directorPauseSignature = await director.signTypedData(
        domain,
        types,
        pauseOperation
      );

      await controller.executeOperation(
        pauseOperation.operationType,
        pauseOperation.to,
        pauseOperation.amount,
        pauseOperation.deadline,
        [managerPauseSignature, directorPauseSignature]
      );

      // Verify token is paused
      expect(await idrp.paused()).to.be.true;

      // Now unpause with officer+manager+director
      const unpauseDeadline = Math.floor(Date.now() / 1000) + 3600;
      const unpauseOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Unpause,
        amount: 0,
        nonce: await controller.nonce(),
        deadline: unpauseDeadline,
      };

      const officerSignature = await officer.signTypedData(
        domain,
        types,
        unpauseOperation
      );
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        unpauseOperation
      );
      const directorSignature = await director.signTypedData(
        domain,
        types,
        unpauseOperation
      );

      await controller.executeOperation(
        unpauseOperation.operationType,
        unpauseOperation.to,
        unpauseOperation.amount,
        unpauseOperation.deadline,
        [officerSignature, managerSignature, directorSignature]
      );

      // Verify token is unpaused
      expect(await idrp.paused()).to.be.false;
    });

    it("Should execute unpause operation with manager+director+commissioner signatures", async function () {
      const {
        controller,
        idrp,
        manager,
        director,
        commissioner,
        domain,
        types,
      } = await loadFixture(deployFixture);

      // First pause the token
      const pauseDeadline = Math.floor(Date.now() / 1000) + 3600;
      const pauseOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Pause,
        amount: 0,
        nonce: await controller.nonce(),
        deadline: pauseDeadline,
      };

      const managerPauseSignature = await manager.signTypedData(
        domain,
        types,
        pauseOperation
      );
      const directorPauseSignature = await director.signTypedData(
        domain,
        types,
        pauseOperation
      );

      await controller.executeOperation(
        pauseOperation.operationType,
        pauseOperation.to,
        pauseOperation.amount,
        pauseOperation.deadline,
        [managerPauseSignature, directorPauseSignature]
      );

      // Verify token is paused
      expect(await idrp.paused()).to.be.true;

      // Now unpause with manager+director+commissioner
      const unpauseDeadline = Math.floor(Date.now() / 1000) + 3600;
      const unpauseOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Unpause,
        amount: 0,
        nonce: await controller.nonce(),
        deadline: unpauseDeadline,
      };

      const managerSignature = await manager.signTypedData(
        domain,
        types,
        unpauseOperation
      );
      const directorSignature = await director.signTypedData(
        domain,
        types,
        unpauseOperation
      );
      const commissionerSignature = await commissioner.signTypedData(
        domain,
        types,
        unpauseOperation
      );

      await controller.executeOperation(
        unpauseOperation.operationType,
        unpauseOperation.to,
        unpauseOperation.amount,
        unpauseOperation.deadline,
        [managerSignature, directorSignature, commissionerSignature]
      );

      // Verify token is unpaused
      expect(await idrp.paused()).to.be.false;
    });

    it("Should fail unpause operation with invalid signature combination", async function () {
      const {
        controller,
        idrp,
        officer,
        manager,
        commissioner,
        domain,
        types,
        director,
      } = await loadFixture(deployFixture);

      // First pause the token
      const pauseDeadline = Math.floor(Date.now() / 1000) + 3600;
      const pauseOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Pause,
        amount: 0,
        nonce: await controller.nonce(),
        deadline: pauseDeadline,
      };

      // Get manager and director signatures for pause
      const managerPauseSignature = await manager.signTypedData(
        domain,
        types,
        pauseOperation
      );
      const directorPauseSignature = await director.signTypedData(
        domain,
        types,
        pauseOperation
      );

      await controller.executeOperation(
        pauseOperation.operationType,
        pauseOperation.to,
        pauseOperation.amount,
        pauseOperation.deadline,
        [managerPauseSignature, directorPauseSignature]
      );

      // Verify token is paused
      expect(await idrp.paused()).to.be.true;

      // Try to unpause with invalid combination: officer+manager+commissioner (missing director)
      const unpauseDeadline = Math.floor(Date.now() / 1000) + 3600;
      const unpauseOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Unpause,
        amount: 0,
        nonce: await controller.nonce(),
        deadline: unpauseDeadline,
      };

      // This is an invalid combination: officer+manager+commissioner (missing director)
      const officerSignature = await officer.signTypedData(
        domain,
        types,
        unpauseOperation
      );
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        unpauseOperation
      );
      const commissionerSignature = await commissioner.signTypedData(
        domain,
        types,
        unpauseOperation
      );

      // Attempt unpause operation with invalid combination, should fail
      await expect(
        controller.executeOperation(
          unpauseOperation.operationType,
          unpauseOperation.to,
          unpauseOperation.amount,
          unpauseOperation.deadline,
          [officerSignature, managerSignature, commissionerSignature]
        )
      ).to.be.revertedWith("Invalid signature combination for unpause");
    });
  });
});

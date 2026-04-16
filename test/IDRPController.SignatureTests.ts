import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController - Signature Tests", function () {
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

  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = hre.ethers.parseUnits("500000000", 6);
  const ONE_BILLION = hre.ethers.parseUnits("1000000000", 6);

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
        { name: "operationIdentifier", type: "string" },
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

    // Set quorum rules
    await controller.setQuorumRules(OperationType.Mint, [
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
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
      },
    ]);

    await controller.setQuorumRules(OperationType.Burn, [
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
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
      },
    ]);

    await controller.setQuorumRules(OperationType.Freeze, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

    await controller.setQuorumRules(OperationType.Unfreeze, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

    await controller.setQuorumRules(OperationType.Pause, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [MANAGER_ROLE, DIRECTOR_ROLE],
      },
    ]);

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

  describe("Signature Usage Tests", function () {
    it("Should allow reuse of signatures if operation fails", async function () {
      const { controller, officer, manager, user, domain, types } =
        await loadFixture(deployFixture);

      const amount = hre.ethers.parseUnits("200000000", 6); // 200M tokens (requires officer + manager)
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const operationIdentifier = "tx201"; // Use operation ID

      // Create operation data
      const operation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      // Get officer to sign
      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );

      // Deliberately try with only officer signature to make it fail
      let firstAttemptFailed = false;
      try {
        await controller.executeOperation(
          operation.operationType,
          operation.to,
          operation.amount,
          operation.operationIdentifier,
          operation.deadline,
          [officerSignature]
        );
      } catch (error) {
        // First attempt should fail - we expect this
        firstAttemptFailed = true;
      }

      // Verify first attempt failed as expected
      expect(firstAttemptFailed).to.equal(true);

      // Now get manager to sign
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation
      );

      // Try again with both signatures - should succeed now
      let secondAttemptSucceeded = true;
      try {
        await controller.executeOperation(
          operation.operationType,
          operation.to,
          operation.amount,
          operation.operationIdentifier,
          operation.deadline,
          [officerSignature, managerSignature]
        );
      } catch (error) {
        // Second attempt should succeed, so this shouldn't execute
        secondAttemptSucceeded = false;
        console.error("Second attempt failed:", error);
      }

      // Verify second attempt succeeded
      expect(secondAttemptSucceeded).to.equal(true);
    });

    it("Should not allow reuse of signatures after successful operation", async function () {
      const { controller, officer, manager, user, domain, types } =
        await loadFixture(deployFixture);

      // First operation with 200M (requires officer + manager)
      const amount = hre.ethers.parseUnits("200000000", 6);
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "tx202"; // First operation ID

      const operation1 = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation1
      );

      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation1
      );

      // Execute first operation successfully
      let firstOperationSucceeded = true;
      try {
        await controller.executeOperation(
          operation1.operationType,
          operation1.to,
          operation1.amount,
          operation1.operationIdentifier,
          operation1.deadline,
          [officerSignature, managerSignature]
        );
      } catch (error) {
        firstOperationSucceeded = false;
        console.error("First operation failed:", error);
      }

      // Verify first operation succeeded
      expect(firstOperationSucceeded).to.equal(true);

      // Try to reuse the same signatures for the same operation
      // Should fail because the operation hash is now marked as used
      let reuseSignaturesFailed = false;
      try {
        await controller.executeOperation(
          operation1.operationType,
          operation1.to,
          operation1.amount,
          operation1.operationIdentifier,
          operation1.deadline,
          [officerSignature, managerSignature]
        );
      } catch (error) {
        // We expect this to fail
        reuseSignaturesFailed = true;
      }

      // Verify signature reuse failed
      expect(reuseSignaturesFailed).to.equal(true);

      // Create a second operation with the same parameters but new operationIdentifier
      const operationIdentifier2 = "tx203"; // New operation ID
      const operation2 = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: operationIdentifier2,
        deadline: deadline,
      };

      // Need new signatures for the new operationIdentifier
      const officerSignature2 = await officer.signTypedData(
        domain,
        types,
        operation2
      );

      const managerSignature2 = await manager.signTypedData(
        domain,
        types,
        operation2
      );

      // This should succeed with the new signatures
      let secondOperationSucceeded = true;
      try {
        await controller.executeOperation(
          operation2.operationType,
          operation2.to,
          operation2.amount,
          operation2.operationIdentifier,
          operation2.deadline,
          [officerSignature2, managerSignature2]
        );
      } catch (error) {
        secondOperationSucceeded = false;
        console.error("Second operation failed:", error);
      }

      // Verify second operation succeeded
      expect(secondOperationSucceeded).to.equal(true);
    });

    it("Should not allow signatures to be used after deadline", async function () {
      const { controller, officer, user, domain, types } = await loadFixture(
        deployFixture
      );

      const amount = hre.ethers.parseUnits("50000000", 6); // 50M tokens (requires only officer)
      const deadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour in the past
      const operationIdentifier = "tx204"; // Use operation ID

      const operation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );

      // Should fail because the deadline has passed
      let operationWithExpiredDeadlineFailed = false;
      try {
        await controller.executeOperation(
          operation.operationType,
          operation.to,
          operation.amount,
          operation.operationIdentifier,
          operation.deadline,
          [officerSignature]
        );
      } catch (error) {
        // This should fail due to expired deadline
        operationWithExpiredDeadlineFailed = true;
      }

      // Verify operation with expired deadline failed
      expect(operationWithExpiredDeadlineFailed).to.equal(true);

    });
  });
});

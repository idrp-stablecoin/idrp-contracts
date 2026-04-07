import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController - Transfer Approach Burn Tests", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("MANAGER_ROLE")
  );
  const DIRECTOR_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("DIRECTOR_ROLE")
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
    const [
      admin,
      officer,
      manager,
      director,
      commissioner,
      user1,
      user2,
      depository,
    ] = await hre.ethers.getSigners();

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
    await controller.setOfficer(officer.address);
    await controller.setManager(manager.address);
    await controller.setDirector(director.address);

    await idrp.setController(await controller.getAddress());

    // Set quorum rules for burn operations
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

    // Set quorum rules for mint operations
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

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      director,
      commissioner,
      user1,
      user2,
      depository,
      domain,
      types,
    };
  }

  describe("Transfer Approach Burn Flow", function () {
    it("Should complete full burn flow: mint -> user receives -> transfers to controller -> burn", async function () {
      const {
        idrp,
        controller,
        officer,
        manager,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const idrpAddress = await idrp.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6); // 50M tokens
      const burnAmount = hre.ethers.parseUnits("30000000", 6); // 30M tokens

      // Step 1: Mint tokens to depository wallet
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-1";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      // Verify depository received tokens
      expect(await idrp.balanceOf(depository.address)).to.equal(mintAmount);

      // Step 2: Depository wallet transfers tokens to user1
      await idrp.connect(depository).transfer(user1.address, burnAmount);

      // Verify user1 received tokens
      expect(await idrp.balanceOf(user1.address)).to.equal(burnAmount);
      expect(await idrp.balanceOf(depository.address)).to.equal(
        mintAmount - burnAmount
      );

      // Step 3: User1 transfers tokens to controller (user initiates burn)
      await idrp.connect(user1).transfer(controllerAddress, burnAmount);

      // Verify tokens are now in controller
      expect(await idrp.balanceOf(controllerAddress)).to.equal(burnAmount);
      expect(await idrp.balanceOf(user1.address)).to.equal(0);

      // Step 4: Maintainers approve and execute burn operation from controller
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "burn-tx-1";
      const burnOperation = {
        to: controllerAddress, // Burn from controller address
        operationType: OperationType.Burn,
        amount: burnAmount,
        operationIdentifier: burnOperationId,
        deadline: burnDeadline,
      };

      const officerBurnSignature = await officer.signTypedData(
        domain,
        types,
        burnOperation
      );

      await controller.executeOperation(
        OperationType.Burn,
        controllerAddress,
        burnAmount,
        burnOperationId,
        burnDeadline,
        [officerBurnSignature]
      );

      // Step 5: Verify burn was successful - tokens removed from controller
      expect(await idrp.balanceOf(controllerAddress)).to.equal(0);
      expect(await idrp.totalSupply()).to.equal(mintAmount - burnAmount);
    });

    it("Should burn from controller without allowance", async function () {
      const { idrp, controller, officer, user1, depository, domain, types } =
        await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const burnAmount = hre.ethers.parseUnits("30000000", 6);

      // Mint and transfer to user
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-2";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, burnAmount);

      // User transfers to controller (no allowance needed)
      await idrp.connect(user1).transfer(controllerAddress, burnAmount);

      // Verify no allowance is set
      const allowance = await idrp.allowance(
        controllerAddress,
        controllerAddress
      );
      expect(allowance).to.equal(0);

      // Execute burn from controller - should succeed without allowance
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "burn-tx-2";
      const burnOperation = {
        to: controllerAddress,
        operationType: OperationType.Burn,
        amount: burnAmount,
        operationIdentifier: burnOperationId,
        deadline: burnDeadline,
      };

      const officerBurnSignature = await officer.signTypedData(
        domain,
        types,
        burnOperation
      );

      // Should not revert even without allowance
      await controller.executeOperation(
        OperationType.Burn,
        controllerAddress,
        burnAmount,
        burnOperationId,
        burnDeadline,
        [officerBurnSignature]
      );

      expect(await idrp.balanceOf(controllerAddress)).to.equal(0);
    });

    it("Should validate user balance before and after transfer to controller", async function () {
      const { idrp, controller, officer, user1, depository, domain, types } =
        await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const transferAmount = hre.ethers.parseUnits("25000000", 6);

      // Mint and transfer to user
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-3";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);

      // Check initial balance
      expect(await idrp.balanceOf(user1.address)).to.equal(transferAmount);

      // User transfers to controller
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Check final balance - user should have 0
      expect(await idrp.balanceOf(user1.address)).to.equal(0);
      // Check controller received the tokens
      expect(await idrp.balanceOf(controllerAddress)).to.equal(transferAmount);
    });

    it("Should handle multiple users burning in sequence", async function () {
      const {
        idrp,
        controller,
        officer,
        manager,
        user1,
        user2,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("100000000", 6);
      const user1BurnAmount = hre.ethers.parseUnits("40000000", 6);
      const user2BurnAmount = hre.ethers.parseUnits("60000000", 6);

      // Mint total amount (100M requires OFFICER + MANAGER)
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-4";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      const managerMintSignature = await manager.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature, managerMintSignature]
      );

      // Distribute to users
      await idrp.connect(depository).transfer(user1.address, user1BurnAmount);
      await idrp.connect(depository).transfer(user2.address, user2BurnAmount);

      // User1 transfers to controller
      await idrp.connect(user1).transfer(controllerAddress, user1BurnAmount);

      // User2 transfers to controller
      await idrp.connect(user2).transfer(controllerAddress, user2BurnAmount);

      // Verify controller has all tokens
      expect(await idrp.balanceOf(controllerAddress)).to.equal(
        user1BurnAmount + user2BurnAmount
      );

      // User1 burn operation
      const burn1Deadline = Math.floor(Date.now() / 1000) + 3600;
      const burn1OperationId = "burn-tx-user1";
      const burn1Operation = {
        to: controllerAddress,
        operationType: OperationType.Burn,
        amount: user1BurnAmount,
        operationIdentifier: burn1OperationId,
        deadline: burn1Deadline,
      };

      const officerBurn1Signature = await officer.signTypedData(
        domain,
        types,
        burn1Operation
      );

      await controller.executeOperation(
        OperationType.Burn,
        controllerAddress,
        user1BurnAmount,
        burn1OperationId,
        burn1Deadline,
        [officerBurn1Signature]
      );

      // Verify user1 tokens burned
      expect(await idrp.balanceOf(controllerAddress)).to.equal(user2BurnAmount);

      // User2 burn operation (requires OFFICER + MANAGER for 60M burn)
      const burn2Deadline = Math.floor(Date.now() / 1000) + 3600;
      const burn2OperationId = "burn-tx-user2";
      const burn2Operation = {
        to: controllerAddress,
        operationType: OperationType.Burn,
        amount: user2BurnAmount,
        operationIdentifier: burn2OperationId,
        deadline: burn2Deadline,
      };

      const officerBurn2Signature = await officer.signTypedData(
        domain,
        types,
        burn2Operation
      );

      const managerBurn2Signature = await manager.signTypedData(
        domain,
        types,
        burn2Operation
      );

      await controller.executeOperation(
        OperationType.Burn,
        controllerAddress,
        user2BurnAmount,
        burn2OperationId,
        burn2Deadline,
        [officerBurn2Signature, managerBurn2Signature]
      );

      // Verify all tokens burned
      expect(await idrp.balanceOf(controllerAddress)).to.equal(0);
      expect(await idrp.totalSupply()).to.equal(0);
    });

    it("Should not allow burn from user address without proper balance", async function () {
      const { idrp, controller, officer, user1, depository, domain, types } =
        await loadFixture(deployFixture);

      const burnAmount = hre.ethers.parseUnits("50000000", 6);

      // Try to burn from user1 address without transfer (should fail - no balance)
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "burn-tx-fail";
      const burnOperation = {
        to: user1.address,
        operationType: OperationType.Burn,
        amount: burnAmount,
        operationIdentifier: burnOperationId,
        deadline: burnDeadline,
      };

      const officerBurnSignature = await officer.signTypedData(
        domain,
        types,
        burnOperation
      );

      await expect(
        controller.executeOperation(
          OperationType.Burn,
          user1.address,
          burnAmount,
          burnOperationId,
          burnDeadline,
          [officerBurnSignature]
        )
      ).to.be.reverted;
    });
  });

  describe("Controller Token Withdrawal", function () {
    it("Should allow owner to withdraw IDRP tokens from controller", async function () {
      const {
        idrp,
        controller,
        officer,
        admin,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const transferAmount = hre.ethers.parseUnits("30000000", 6);
      const withdrawAmount = hre.ethers.parseUnits("20000000", 6);

      // Mint and transfer to user, then user transfers to controller
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-5";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Verify controller has tokens
      expect(await idrp.balanceOf(controllerAddress)).to.equal(transferAmount);

      // Owner withdraws tokens
      await controller
        .connect(admin)
        .withdrawToken(await idrp.getAddress(), user1.address, withdrawAmount);

      // Verify withdrawal
      expect(await idrp.balanceOf(controllerAddress)).to.equal(
        transferAmount - withdrawAmount
      );
      expect(await idrp.balanceOf(user1.address)).to.equal(withdrawAmount);
    });

    it("Should allow owner to withdraw all IDRP tokens from controller", async function () {
      const {
        idrp,
        controller,
        officer,
        admin,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const transferAmount = hre.ethers.parseUnits("30000000", 6);

      // Setup: mint and transfer
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-6";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Withdraw all tokens
      await controller
        .connect(admin)
        .withdrawToken(await idrp.getAddress(), user1.address, transferAmount);

      // Verify complete withdrawal
      expect(await idrp.balanceOf(controllerAddress)).to.equal(0);
      expect(await idrp.balanceOf(user1.address)).to.equal(transferAmount);
    });

    it("Should not allow non-owner to withdraw IDRP tokens", async function () {
      const { idrp, controller, officer, user1, depository, domain, types } =
        await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const transferAmount = hre.ethers.parseUnits("30000000", 6);

      // Setup
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-7";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Try to withdraw as non-owner - should fail
      await expect(
        controller
          .connect(user1)
          .withdrawToken(await idrp.getAddress(), user1.address, transferAmount)
      ).to.be.reverted;
    });

    it("Should not allow withdrawal to zero address", async function () {
      const {
        idrp,
        controller,
        officer,
        admin,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const transferAmount = hre.ethers.parseUnits("30000000", 6);

      // Setup
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-8";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Try to withdraw to zero address - should fail
      await expect(
        controller
          .connect(admin)
          .withdrawToken(
            await idrp.getAddress(),
            hre.ethers.ZeroAddress,
            transferAmount
          )
      ).to.be.reverted;
    });

    it("Should track withdrawal events", async function () {
      const {
        idrp,
        controller,
        officer,
        admin,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("50000000", 6);
      const transferAmount = hre.ethers.parseUnits("30000000", 6);
      const withdrawAmount = hre.ethers.parseUnits("20000000", 6);

      // Setup
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-9";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Withdraw and check for event
      await expect(
        controller
          .connect(admin)
          .withdrawToken(await idrp.getAddress(), user1.address, withdrawAmount)
      )
        .to.emit(controller, "TokensWithdrawn")
        .withArgs(await idrp.getAddress(), user1.address, withdrawAmount);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle partial burn with tokens remaining in controller", async function () {
      const {
        idrp,
        controller,
        officer,
        manager,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("100000000", 6);
      const transferAmount = hre.ethers.parseUnits("50000000", 6);
      const burnAmount = hre.ethers.parseUnits("30000000", 6);

      // Mint and setup (100M requires OFFICER + MANAGER)
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-10";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      const managerMintSignature = await manager.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature, managerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // Burn partial amount
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "burn-tx-partial";
      const burnOperation = {
        to: controllerAddress,
        operationType: OperationType.Burn,
        amount: burnAmount,
        operationIdentifier: burnOperationId,
        deadline: burnDeadline,
      };

      const officerBurnSignature = await officer.signTypedData(
        domain,
        types,
        burnOperation
      );

      await controller.executeOperation(
        OperationType.Burn,
        controllerAddress,
        burnAmount,
        burnOperationId,
        burnDeadline,
        [officerBurnSignature]
      );

      // Verify remaining tokens
      expect(await idrp.balanceOf(controllerAddress)).to.equal(
        transferAmount - burnAmount
      );
      expect(await idrp.totalSupply()).to.equal(mintAmount - burnAmount);
    });

    it("Should prevent double-spending from same token batch", async function () {
      const {
        idrp,
        controller,
        officer,
        manager,
        user1,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const controllerAddress = await controller.getAddress();
      const mintAmount = hre.ethers.parseUnits("100000000", 6);
      const transferAmount = hre.ethers.parseUnits("50000000", 6);
      const burnAmount = hre.ethers.parseUnits("30000000", 6);

      // Mint and setup (100M requires OFFICER + MANAGER)
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "mint-tx-11";
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      const managerMintSignature = await manager.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        mintAmount,
        mintOperationId,
        mintDeadline,
        [officerMintSignature, managerMintSignature]
      );

      await idrp.connect(depository).transfer(user1.address, transferAmount);
      await idrp.connect(user1).transfer(controllerAddress, transferAmount);

      // First burn
      const burn1Deadline = Math.floor(Date.now() / 1000) + 3600;
      const burn1OperationId = "burn-tx-first";
      const burn1Operation = {
        to: controllerAddress,
        operationType: OperationType.Burn,
        amount: burnAmount,
        operationIdentifier: burn1OperationId,
        deadline: burn1Deadline,
      };

      const officerBurn1Signature = await officer.signTypedData(
        domain,
        types,
        burn1Operation
      );

      await controller.executeOperation(
        OperationType.Burn,
        controllerAddress,
        burnAmount,
        burn1OperationId,
        burn1Deadline,
        [officerBurn1Signature]
      );

      // Try to burn the same amount again - should fail due to insufficient balance
      const burn2Deadline = Math.floor(Date.now() / 1000) + 3600;
      const burn2OperationId = "burn-tx-duplicate";
      const burn2Operation = {
        to: controllerAddress,
        operationType: OperationType.Burn,
        amount: burnAmount,
        operationIdentifier: burn2OperationId,
        deadline: burn2Deadline,
      };

      const officerBurn2Signature = await officer.signTypedData(
        domain,
        types,
        burn2Operation
      );

      const managerBurn2Signature = await manager.signTypedData(
        domain,
        types,
        burn2Operation
      );

      await expect(
        controller.executeOperation(
          OperationType.Burn,
          controllerAddress,
          burnAmount,
          burn2OperationId,
          burn2Deadline,
          [officerBurn2Signature, managerBurn2Signature]
        )
      ).to.be.reverted;
    });
  });
});

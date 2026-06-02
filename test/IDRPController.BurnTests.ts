import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController - Burn Tests", function () {
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

    // v3: wire IDRP -> Controller for operational gating.
    await idrp.connect(admin).setController(await controller.getAddress());

    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await controller.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await controller.connect(admin).grantRole(DIRECTOR_ROLE, director.address);

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
      user,
      depository,
      domain,
      types,
    };
  }

  describe("Burn Operations", function () {
    it("Should fail to burn without allowance", async function () {
      const { idrp, controller, officer, user, depository, domain, types } =
        await loadFixture(deployFixture);

      // First mint some tokens to the user
      const mintAmount = hre.ethers.parseUnits("50000000", 6); // 50M tokens

      // Mint operation
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "tx1"; // Use operation ID from database
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      // Sign and execute mint
      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        mintOperation.operationType,
        mintOperation.to,
        mintOperation.amount,
        mintOperation.operationIdentifier,
        mintOperation.deadline,
        [officerMintSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, mintAmount);

      // Verify minted balance
      expect(await idrp.balanceOf(user.address)).to.equal(mintAmount);

      // Try to burn without allowance
      const burnAmount = hre.ethers.parseUnits("25000000", 6); // 25M tokens

      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "tx2"; // Use different operation ID
      const burnOperation = {
        to: user.address,
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

      // This should fail because user has not approved the controller to burn tokens
      await expect(
        controller.executeOperation(
          burnOperation.operationType,
          burnOperation.to,
          burnOperation.amount,
          burnOperation.operationIdentifier,
          burnOperation.deadline,
          [officerBurnSignature]
        )
      ).to.be.revertedWith("Burn amount exceeds allowance");

      // Verify balance is unchanged
      expect(await idrp.balanceOf(user.address)).to.equal(mintAmount);
    });

    it("Should successfully burn with proper allowance", async function () {
      const { idrp, controller, officer, user, depository, domain, types } =
        await loadFixture(deployFixture);

      // First mint some tokens to the user
      const mintAmount = hre.ethers.parseUnits("50000000", 6); // 50M tokens

      // Mint operation
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "tx3"; // Use operation ID
      const mintOperation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: mintAmount,
        operationIdentifier: mintOperationId,
        deadline: mintDeadline,
      };

      // Sign and execute mint
      const officerMintSignature = await officer.signTypedData(
        domain,
        types,
        mintOperation
      );

      await controller.executeOperation(
        mintOperation.operationType,
        mintOperation.to,
        mintOperation.amount,
        mintOperation.operationIdentifier,
        mintOperation.deadline,
        [officerMintSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, mintAmount);

      // Verify minted balance
      expect(await idrp.balanceOf(user.address)).to.equal(mintAmount);

      // Set allowance for controller to burn
      const burnAmount = hre.ethers.parseUnits("25000000", 6); // 25M tokens
      await idrp.connect(user).approve(controller.getAddress(), burnAmount);

      // Verify allowance
      expect(
        await idrp.allowance(user.address, controller.getAddress())
      ).to.equal(burnAmount);

      // Now burn tokens
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "tx4"; // Different operation ID
      const burnOperation = {
        to: user.address,
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
        burnOperation.operationType,
        burnOperation.to,
        burnOperation.amount,
        burnOperation.operationIdentifier,
        burnOperation.deadline,
        [officerBurnSignature]
      );

      // Verify balance after burn
      expect(await idrp.balanceOf(user.address)).to.equal(
        mintAmount - burnAmount
      );

      // Verify allowance is used up
      expect(
        await idrp.allowance(user.address, controller.getAddress())
      ).to.equal(0);
    });

    it("Should fail to burn with insufficient allowance", async function () {
      const { idrp, controller, officer, user, depository, domain, types } =
        await loadFixture(deployFixture);

      // Mint tokens to the user
      const mintAmount = hre.ethers.parseUnits("50000000", 6); // 50M tokens

      // Mint operation
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "tx5"; // Use operation ID
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
        mintOperation.operationType,
        mintOperation.to,
        mintOperation.amount,
        mintOperation.operationIdentifier,
        mintOperation.deadline,
        [officerMintSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, mintAmount);

      // Set INSUFFICIENT allowance
      const allowanceAmount = hre.ethers.parseUnits("10000000", 6); // 10M tokens
      const burnAmount = hre.ethers.parseUnits("25000000", 6); // 25M tokens (more than allowance)

      await idrp
        .connect(user)
        .approve(controller.getAddress(), allowanceAmount);

      // Verify allowance
      expect(
        await idrp.allowance(user.address, controller.getAddress())
      ).to.equal(allowanceAmount);

      // Try to burn more than allowance
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "tx6"; // Different operation ID
      const burnOperation = {
        to: user.address,
        operationType: OperationType.Burn,
        amount: burnAmount, // More than allowance
        operationIdentifier: burnOperationId,
        deadline: burnDeadline,
      };

      const officerBurnSignature = await officer.signTypedData(
        domain,
        types,
        burnOperation
      );

      // Should fail due to insufficient allowance
      await expect(
        controller.executeOperation(
          burnOperation.operationType,
          burnOperation.to,
          burnOperation.amount,
          burnOperation.operationIdentifier,
          burnOperation.deadline,
          [officerBurnSignature]
        )
      ).to.be.revertedWith("Burn amount exceeds allowance");

      // Verify balance and allowance are unchanged
      expect(await idrp.balanceOf(user.address)).to.equal(mintAmount);
      expect(
        await idrp.allowance(user.address, controller.getAddress())
      ).to.equal(allowanceAmount);
    });

    it("Should burn the exact allowance amount", async function () {
      const { idrp, controller, officer, user, depository, domain, types } =
        await loadFixture(deployFixture);

      // Mint tokens to the user
      const mintAmount = hre.ethers.parseUnits("50000000", 6); // 50M tokens

      // Mint operation
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperationId = "tx7"; // Use operation ID
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
        mintOperation.operationType,
        mintOperation.to,
        mintOperation.amount,
        mintOperation.operationIdentifier,
        mintOperation.deadline,
        [officerMintSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, mintAmount);

      // Set exact allowance
      const burnAmount = hre.ethers.parseUnits("25000000", 6); // 25M tokens

      await idrp.connect(user).approve(controller.getAddress(), burnAmount);

      // Verify allowance
      expect(
        await idrp.allowance(user.address, controller.getAddress())
      ).to.equal(burnAmount);

      // Burn exactly the allowance amount
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperationId = "tx8"; // Different operation ID
      const burnOperation = {
        to: user.address,
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
        burnOperation.operationType,
        burnOperation.to,
        burnOperation.amount,
        burnOperation.operationIdentifier,
        burnOperation.deadline,
        [officerBurnSignature]
      );

      // Verify burn was successful
      expect(await idrp.balanceOf(user.address)).to.equal(
        mintAmount - burnAmount
      );
      expect(
        await idrp.allowance(user.address, controller.getAddress())
      ).to.equal(0);
    });
  });
});

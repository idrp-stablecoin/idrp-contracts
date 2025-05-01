import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController", function () {
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

  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6);
  const FIVE_HUNDRED_MILLION = hre.ethers.parseUnits("500000000", 6);
  const ONE_BILLION = hre.ethers.parseUnits("1000000000", 6);
  const TEN_BILLION = hre.ethers.parseUnits("10000000000", 6);

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
    //const IDRPControllerFactory = await hre.ethers.getContractFactory("IDRPController")
    //const controller = await IDRPControllerFactory.deploy(await idrp.getAddress(), admin.address)
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

    await controller.setQuorumRules(OperationType.Freeze, [
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
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]);

    await controller.setQuorumRules(OperationType.Unfreeze, [
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
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]);

    // Set quorum rules for Pause and Unpause
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

  describe("Quorum Rules", function () {
    it("Should correctly set quorum rules for mint", async function () {
      const { controller } = await loadFixture(deployFixture);
      const rule = await controller.getQuorumRule(OperationType.Mint, 0);
      expect(rule.minAmount).to.equal(0);
      expect(rule.maxAmount).to.equal(ONE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(1);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
    });

    it("Should correctly set quorum rules for burn", async function () {
      const { controller } = await loadFixture(deployFixture);
      const rule = await controller.getQuorumRule(OperationType.Burn, 0);
      expect(rule.minAmount).to.equal(0);
      expect(rule.maxAmount).to.equal(ONE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(1);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
    });

    it("Should correctly set quorum rules for freeze", async function () {
      const { controller } = await loadFixture(deployFixture);
      const rule = await controller.getQuorumRule(OperationType.Freeze, 0);
      expect(rule.minAmount).to.equal(0);
      expect(rule.maxAmount).to.equal(FIVE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(1);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
    });

    it("Should correctly set quorum rules for unfreeze", async function () {
      const { controller } = await loadFixture(deployFixture);
      const rule = await controller.getQuorumRule(OperationType.Unfreeze, 0);
      expect(rule.minAmount).to.equal(0);
      expect(rule.maxAmount).to.equal(FIVE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(1);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
    });

    it("Should correctly set quorum rules for pause", async function () {
      const { controller } = await loadFixture(deployFixture);
      const rule = await controller.getQuorumRule(OperationType.Pause, 0);
      expect(rule.minAmount).to.equal(0);
      expect(rule.maxAmount).to.equal(hre.ethers.MaxUint256);
      expect(rule.requiredRoles.length).to.equal(2);
      expect(rule.requiredRoles[0]).to.equal(MANAGER_ROLE);
      expect(rule.requiredRoles[1]).to.equal(DIRECTOR_ROLE);
    });
  });

  describe("Signature Verification", function () {
    it("Should execute operation with proper signatures - small amount", async function () {
      const { controller, idrp, officer, depository, user, domain, types } =
        await loadFixture(deployFixture);
      const amount = hre.ethers.parseUnits("50000000", 6); // 50M tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Create operation data
      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      // Get officer to sign
      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );

      // Execute operation with officer's signature
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.deadline,
        [officerSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, amount);

      // Verify IDRP balance
      expect(await idrp.balanceOf(user.address)).to.equal(amount);
    });

    it("Should execute operation with proper signatures - large amount", async function () {
      const {
        controller,
        idrp,
        officer,
        manager,
        director,
        commissioner,
        depository,
        user,
        domain,
        types,
      } = await loadFixture(deployFixture);
      const amount = hre.ethers.parseUnits("1500000000", 6); // 1.5B tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Create operation data
      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      // Get all required signatures
      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation
      );
      const directorSignature = await director.signTypedData(
        domain,
        types,
        operation
      );
      const commissionerSignature = await commissioner.signTypedData(
        domain,
        types,
        operation
      );

      // Execute operation with all signatures
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.deadline,
        [
          officerSignature,
          managerSignature,
          directorSignature,
          commissionerSignature,
        ]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, amount);

      // Verify IDRP balance
      expect(await idrp.balanceOf(user.address)).to.equal(amount);
    });

    it("Should fail if signatures are insufficient", async function () {
      const { controller, idrp, officer, manager, user, domain, types } =
        await loadFixture(deployFixture);
      const amount = hre.ethers.parseUnits("1500000000", 6); // 1.5B tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Create operation data
      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      // Only get officer and manager signatures, should require all 4 roles
      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation
      );

      // Use try/catch to verify the operation fails
      let failedAsExpected = false;
      try {
        await controller.executeOperation(
          operation.operationType,
          operation.to,
          operation.amount,
          operation.deadline,
          [officerSignature, managerSignature]
        );
      } catch (error) {
        // The operation should fail, so we catch the error
        failedAsExpected = true;
      }

      // Verify the operation did indeed fail
      expect(failedAsExpected).to.be.true;
    });
  });

  describe("Token Operations", function () {
    it("Should execute mint operation", async function () {
      const { controller, idrp, officer, depository, user, domain, types } =
        await loadFixture(deployFixture);
      const amount = hre.ethers.parseUnits("50000000", 6); // 50M tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Create operation data
      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      // Get officer to sign (only need officer for small amount)
      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );

      // Execute operation with officer's signature
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.deadline,
        [officerSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, amount);

      // Verify IDRP balance
      expect(await idrp.balanceOf(user.address)).to.equal(amount);
    });

    it("Should execute mint operation with amount 200M", async function () {
      const {
        controller,
        idrp,
        officer,
        manager,
        depository,
        user,
        domain,
        types,
      } = await loadFixture(deployFixture);
      const amount = hre.ethers.parseUnits("200000000", 6); // 200M tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );

      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation
      );

      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.deadline,
        [officerSignature, managerSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, amount);

      expect(await idrp.balanceOf(user.address)).to.equal(amount);

      // should fail if only officer signs
      let failedAsExpected = false;
      try {
        await controller.executeOperation(
          operation.operationType,
          operation.to,
          operation.amount,
          operation.deadline,
          [officerSignature]
        );
      } catch (error) {
        failedAsExpected = true;
      }

      expect(failedAsExpected).to.be.true;
    });

    it("Should execute burn operation", async function () {
      const { controller, idrp, officer, depository, user, domain, types } =
        await loadFixture(deployFixture);

      // First mint some tokens to the user
      const mintAmount = hre.ethers.parseUnits("50000000", 6);

      // Mint operation
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: mintAmount,
        nonce: await controller.nonce(),
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
        mintOperation.deadline,
        [officerMintSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, mintAmount);

      // Verify minted balance
      expect(await idrp.balanceOf(user.address)).to.equal(mintAmount);

      // Then burn half the tokens
      const burnAmount = hre.ethers.parseUnits("25000000", 6);

      // User needs to approve controller for burn
      await idrp
        .connect(user)
        .approve(await controller.getAddress(), burnAmount);

      // Burn operation
      const burnDeadline = Math.floor(Date.now() / 1000) + 3600;
      const burnOperation = {
        to: user.address,
        operationType: OperationType.Burn,
        amount: burnAmount,
        nonce: await controller.nonce(),
        deadline: burnDeadline,
      };

      // Sign and execute burn
      const officerBurnSignature = await officer.signTypedData(
        domain,
        types,
        burnOperation
      );

      await controller.executeOperation(
        burnOperation.operationType,
        burnOperation.to,
        burnOperation.amount,
        burnOperation.deadline,
        [officerBurnSignature]
      );

      // Verify final balance
      expect(await idrp.balanceOf(user.address)).to.equal(
        mintAmount - burnAmount
      );
    });

    it("Should execute freeze operation", async function () {
      const { controller, idrp, admin, officer, user, domain, types } =
        await loadFixture(deployFixture);

      // First mint some tokens to the user so we can test freezing affects transfers
      const mintAmount = hre.ethers.parseUnits("50000000", 6);

      // Mint operation - simplified to focus on freeze test
      const mintDeadline = Math.floor(Date.now() / 1000) + 3600;
      const mintOperation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: mintAmount,
        nonce: await controller.nonce(),
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
        mintOperation.deadline,
        [officerMintSignature]
      );

      // Now freeze the user account
      const freezeDeadline = Math.floor(Date.now() / 1000) + 3600;
      const freezeOperation = {
        to: user.address,
        operationType: OperationType.Freeze,
        amount: 0, // Amount doesn't matter for freeze
        nonce: await controller.nonce(),
        deadline: freezeDeadline,
      };

      const officerFreezeSignature = await officer.signTypedData(
        domain,
        types,
        freezeOperation
      );
      await controller.executeOperation(
        freezeOperation.operationType,
        freezeOperation.to,
        freezeOperation.amount,
        freezeOperation.deadline,
        [officerFreezeSignature]
      );

      // Verify account is frozen
      expect(await idrp.frozen(user.address)).to.be.true;

      // Verify frozen account can't transfer tokens
      await expect(
        idrp
          .connect(user)
          .transfer(admin.address, hre.ethers.parseUnits("1000", 6))
      ).to.be.rejected;
    });

    it("Should execute operation with more than required signatures", async function () {
      const {
        controller,
        idrp,
        officer,
        manager,
        depository,
        user,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const amount = hre.ethers.parseUnits("50000000", 6); // 50M tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      };

      const officerSignature = await officer.signTypedData(
        domain,
        types,
        operation
      );

      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation
      );

      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.deadline,
        [officerSignature, managerSignature]
      );

      // Transfer tokens from depository to user
      await idrp.connect(depository).transfer(user.address, amount);

      expect(await idrp.balanceOf(user.address)).to.equal(amount);
    });

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

      // This is an invalid combination: officer+manager+commissioner
      // Both valid combinations need director
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

  describe("Withdrawal", function () {
    it("Should allow withdrawal of other tokens", async function () {
      const { controller, depository, admin } = await loadFixture(
        deployFixture
      );

      // Deploy a test ERC20 token
      const TestTokenFactory = await hre.ethers.getContractFactory("IDRP"); // Reusing IDRP for simplicity
      const testToken = await hre.upgrades.deployProxy(TestTokenFactory, [
        admin.address,
      ]);
      await testToken.waitForDeployment();

      // Set depositoryWallet
      await testToken.connect(admin).setDepositoryWallet(depository.address);

      // Mint some tokens to the depository
      await testToken.connect(admin).mint(hre.ethers.parseUnits("1000", 6));

      // Transfer some tokens to the controller
      const transferAmount = hre.ethers.parseUnits("1000", 6);
      await testToken
        .connect(depository)
        .transfer(await controller.getAddress(), transferAmount);

      // Verify controller has the tokens
      expect(await testToken.balanceOf(await controller.getAddress())).to.equal(
        transferAmount
      );

      // Admin withdraws the tokens
      await controller
        .connect(admin)
        .withdrawToken(
          await testToken.getAddress(),
          admin.address,
          transferAmount
        );

      // Verify balances after withdrawal
      expect(await testToken.balanceOf(await controller.getAddress())).to.equal(
        0
      );
      expect(await testToken.balanceOf(admin.address)).to.equal(
        hre.ethers.parseUnits("1000", 6)
      );
    });

    it("Should not allow withdrawal of IDRP token", async function () {
      const { controller, idrp, admin, depository } = await loadFixture(
        deployFixture
      );

      // Mint some IDRP tokens to the controller for testing
      await idrp.connect(admin).mint(hre.ethers.parseUnits("100", 6));

      // Transfer some IDRP tokens to the controller
      await idrp
        .connect(depository)
        .transfer(
          await controller.getAddress(),
          hre.ethers.parseUnits("100", 6)
        );

      // Attempt to withdraw IDRP tokens, should fail
      await expect(
        controller
          .connect(admin)
          .withdrawToken(
            await idrp.getAddress(),
            admin.address,
            hre.ethers.parseUnits("100", 6)
          )
      ).to.be.revertedWith("Cannot withdraw IDRP token");

      // Verify tokens still in controller
      expect(await idrp.balanceOf(await controller.getAddress())).to.equal(
        hre.ethers.parseUnits("100", 6)
      );
    });
  });
});

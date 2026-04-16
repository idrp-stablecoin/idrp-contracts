import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController - Quorum Rule Tests", function () {
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

  // Constants for token amounts using 6 decimals
  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6);
  const ONE_HUNDRED_MILLION_PLUS_ONE = hre.ethers.parseUnits("100000001", 6);
  const FIVE_HUNDRED_MILLION = hre.ethers.parseUnits("500000000", 6);
  const FIVE_HUNDRED_MILLION_PLUS_ONE = hre.ethers.parseUnits("500000001", 6);
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

    // Set quorum rules for mint
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
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]);

    // Set same quorum rules for burn
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
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [
          OFFICER_ROLE,
          MANAGER_ROLE,
          DIRECTOR_ROLE,
          COMMISSIONER_ROLE,
        ],
      },
    ]);

    // Set quorum rules for freeze and unfreeze with different thresholds
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

    // Apply the same rules for unfreeze as freeze
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

  describe("getQuorumRule Tests", function () {
    it("Should get correct quorum rule for small amount (< 100M)", async function () {
      const { controller } = await loadFixture(deployFixture);

      const amount = hre.ethers.parseUnits("50000000", 6); // 50M tokens
      console.log(`Testing amount: ${hre.ethers.formatUnits(amount, 6)} IDRP`);

      const rule = await controller.getQuorumRule(OperationType.Mint, amount);

      console.log(
        "Required roles:",
        rule.requiredRoles.length === 1 ? "OFFICER_ROLE" : "Multiple roles"
      );
      console.log("Min amount:", hre.ethers.formatUnits(rule.minAmount, 6));
      console.log("Max amount:", hre.ethers.formatUnits(rule.maxAmount, 6));

      expect(rule.minAmount).to.equal(0);
      expect(rule.maxAmount).to.equal(ONE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(1);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
    });

    it("Should get correct quorum rule for amount = 100M", async function () {
      const { controller } = await loadFixture(deployFixture);

      const amount = ONE_HUNDRED_MILLION;
      console.log(`Testing amount: ${hre.ethers.formatUnits(amount, 6)} IDRP`);

      const rule = await controller.getQuorumRule(OperationType.Mint, amount);

      console.log(
        "Required roles:",
        rule.requiredRoles
          .map((r) =>
            r === OFFICER_ROLE
              ? "OFFICER_ROLE"
              : r === MANAGER_ROLE
              ? "MANAGER_ROLE"
              : r === DIRECTOR_ROLE
              ? "DIRECTOR_ROLE"
              : r === COMMISSIONER_ROLE
              ? "COMMISSIONER_ROLE"
              : "Unknown"
          )
          .join(", ")
      );
      console.log("Min amount:", hre.ethers.formatUnits(rule.minAmount, 6));
      console.log("Max amount:", hre.ethers.formatUnits(rule.maxAmount, 6));

      expect(rule.minAmount).to.equal(ONE_HUNDRED_MILLION);
      expect(rule.maxAmount).to.equal(FIVE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(2);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
      expect(rule.requiredRoles[1]).to.equal(MANAGER_ROLE);
    });

    it("Should get correct quorum rule for 100M + 1", async function () {
      const { controller } = await loadFixture(deployFixture);

      const amount = ONE_HUNDRED_MILLION_PLUS_ONE;
      console.log(`Testing amount: ${hre.ethers.formatUnits(amount, 6)} IDRP`);

      const rule = await controller.getQuorumRule(OperationType.Mint, amount);

      console.log(
        "Required roles:",
        rule.requiredRoles
          .map((r) =>
            r === OFFICER_ROLE
              ? "OFFICER_ROLE"
              : r === MANAGER_ROLE
              ? "MANAGER_ROLE"
              : r === DIRECTOR_ROLE
              ? "DIRECTOR_ROLE"
              : r === COMMISSIONER_ROLE
              ? "COMMISSIONER_ROLE"
              : "Unknown"
          )
          .join(", ")
      );
      console.log("Min amount:", hre.ethers.formatUnits(rule.minAmount, 6));
      console.log("Max amount:", hre.ethers.formatUnits(rule.maxAmount, 6));

      expect(rule.minAmount).to.equal(ONE_HUNDRED_MILLION);
      expect(rule.maxAmount).to.equal(FIVE_HUNDRED_MILLION);
      expect(rule.requiredRoles.length).to.equal(2);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
      expect(rule.requiredRoles[1]).to.equal(MANAGER_ROLE);
    });

    it("Should get correct quorum rule for 500M", async function () {
      const { controller } = await loadFixture(deployFixture);

      const amount = FIVE_HUNDRED_MILLION;
      console.log(`Testing amount: ${hre.ethers.formatUnits(amount, 6)} IDRP`);

      const rule = await controller.getQuorumRule(OperationType.Mint, amount);

      console.log(
        "Required roles:",
        rule.requiredRoles
          .map((r) =>
            r === OFFICER_ROLE
              ? "OFFICER_ROLE"
              : r === MANAGER_ROLE
              ? "MANAGER_ROLE"
              : r === DIRECTOR_ROLE
              ? "DIRECTOR_ROLE"
              : r === COMMISSIONER_ROLE
              ? "COMMISSIONER_ROLE"
              : "Unknown"
          )
          .join(", ")
      );
      console.log("Min amount:", hre.ethers.formatUnits(rule.minAmount, 6));
      console.log("Max amount:", hre.ethers.formatUnits(rule.maxAmount, 6));

      expect(rule.minAmount).to.equal(FIVE_HUNDRED_MILLION);
      expect(rule.maxAmount).to.equal(ONE_BILLION);
      expect(rule.requiredRoles.length).to.equal(3);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
      expect(rule.requiredRoles[1]).to.equal(MANAGER_ROLE);
      expect(rule.requiredRoles[2]).to.equal(DIRECTOR_ROLE);
    });

    it("Should get correct quorum rule for 1B", async function () {
      const { controller } = await loadFixture(deployFixture);

      const amount = ONE_BILLION;
      console.log(`Testing amount: ${hre.ethers.formatUnits(amount, 6)} IDRP`);

      const rule = await controller.getQuorumRule(OperationType.Mint, amount);

      console.log(
        "Required roles:",
        rule.requiredRoles
          .map((r) =>
            r === OFFICER_ROLE
              ? "OFFICER_ROLE"
              : r === MANAGER_ROLE
              ? "MANAGER_ROLE"
              : r === DIRECTOR_ROLE
              ? "DIRECTOR_ROLE"
              : r === COMMISSIONER_ROLE
              ? "COMMISSIONER_ROLE"
              : "Unknown"
          )
          .join(", ")
      );
      console.log("Min amount:", hre.ethers.formatUnits(rule.minAmount, 6));
      console.log("Max amount:", hre.ethers.formatUnits(rule.maxAmount, 6));

      expect(rule.minAmount).to.equal(ONE_BILLION);
      expect(rule.maxAmount).to.equal(hre.ethers.MaxUint256);
      expect(rule.requiredRoles.length).to.equal(4);
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE);
      expect(rule.requiredRoles[1]).to.equal(MANAGER_ROLE);
      expect(rule.requiredRoles[2]).to.equal(DIRECTOR_ROLE);
      expect(rule.requiredRoles[3]).to.equal(COMMISSIONER_ROLE);
    });
  });

  describe("Operation Tests Based on Rule Amounts", function () {
    it("Should execute mint with officer only for small amount", async function () {
      const { controller, idrp, officer, depository, domain, types } =
        await loadFixture(deployFixture);

      const amount = hre.ethers.parseUnits("50000000", 6); // 50M tokens
      console.log(
        `\nTesting mint operation with amount: ${hre.ethers.formatUnits(
          amount,
          6
        )} IDRP`
      );
      console.log("Expected required roles: OFFICER_ROLE");

      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "tx101"; // Use operation ID

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

      // Execute with just officer signature
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.operationIdentifier,
        operation.deadline,
        [officerSignature]
      );

      // Verify tokens were minted
      expect(await idrp.balanceOf(depository.address)).to.equal(amount);

      console.log("✓ Mint operation successful with only officer signature");
    });

    it("Should require officer + manager for 100M + 1", async function () {
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

      const amount = ONE_HUNDRED_MILLION_PLUS_ONE; // Just above 100M
      console.log(
        `\nTesting mint operation with amount: ${hre.ethers.formatUnits(
          amount,
          6
        )} IDRP`
      );
      console.log("Expected required roles: OFFICER_ROLE, MANAGER_ROLE");

      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "tx102"; // Use operation ID

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

      // Try with only officer signature - should fail
      let officerOnlyFailed = false;
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
        officerOnlyFailed = true;
      }
      expect(officerOnlyFailed).to.equal(true);

      console.log(
        "✓ Mint operation failed with only officer signature as expected"
      );

      // Now get manager to sign too
      const managerSignature = await manager.signTypedData(
        domain,
        types,
        operation
      );

      // Try with both signatures - should succeed
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.operationIdentifier,
        operation.deadline,
        [officerSignature, managerSignature]
      );

      // Verify tokens were minted
      expect(await idrp.balanceOf(depository.address)).to.equal(amount);

      console.log(
        "✓ Mint operation successful with officer + manager signatures"
      );
    });

    it("Should require officer + manager + director for 500M + 1", async function () {
      const {
        controller,
        idrp,
        officer,
        manager,
        director,
        depository,
        domain,
        types,
      } = await loadFixture(deployFixture);

      const amount = FIVE_HUNDRED_MILLION_PLUS_ONE; // Just above 500M
      console.log(
        `\nTesting mint operation with amount: ${hre.ethers.formatUnits(
          amount,
          6
        )} IDRP`
      );
      console.log(
        "Expected required roles: OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE"
      );

      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const operationIdentifier = "tx103"; // Use operation ID

      const operation = {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount: amount,
        operationIdentifier: operationIdentifier,
        deadline: deadline,
      };

      // Get officer and manager to sign
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

      // Try with only officer + manager - should fail
      let officerManagerFailed = false;
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
        officerManagerFailed = true;
      }
      expect(officerManagerFailed).to.equal(true);

      console.log(
        "✓ Mint operation failed with only officer + manager signatures as expected"
      );

      // Now get director to sign too
      const directorSignature = await director.signTypedData(
        domain,
        types,
        operation
      );

      // Try with all three signatures - should succeed
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.operationIdentifier,
        operation.deadline,
        [officerSignature, managerSignature, directorSignature]
      );

      // Verify tokens were minted
      expect(await idrp.balanceOf(depository.address)).to.equal(amount);

      console.log(
        "✓ Mint operation successful with officer + manager + director signatures"
      );
    });

    it("Should get correct rule for freeze with different thresholds", async function () {
      const { controller } = await loadFixture(deployFixture);

      // Test small amount freeze rule
      const smallAmount = hre.ethers.parseUnits("100000000", 6); // 100M
      console.log(
        `\nTesting freeze rule with amount: ${hre.ethers.formatUnits(
          smallAmount,
          6
        )} IDRP`
      );

      const smallRule = await controller.getQuorumRule(
        OperationType.Freeze,
        smallAmount
      );

      console.log(
        "Required roles:",
        smallRule.requiredRoles
          .map((r) =>
            r === OFFICER_ROLE
              ? "OFFICER_ROLE"
              : r === MANAGER_ROLE
              ? "MANAGER_ROLE"
              : r === DIRECTOR_ROLE
              ? "DIRECTOR_ROLE"
              : r === COMMISSIONER_ROLE
              ? "COMMISSIONER_ROLE"
              : "Unknown"
          )
          .join(", ")
      );
      console.log(
        "Min amount:",
        hre.ethers.formatUnits(smallRule.minAmount, 6)
      );
      console.log(
        "Max amount:",
        hre.ethers.formatUnits(smallRule.maxAmount, 6)
      );

      expect(smallRule.requiredRoles.length).to.equal(1);
      expect(smallRule.requiredRoles[0]).to.equal(OFFICER_ROLE);

      // Test large amount freeze rule
      const largeAmount = hre.ethers.parseUnits("12000000000", 6); // 12B
      console.log(
        `\nTesting freeze rule with amount: ${hre.ethers.formatUnits(
          largeAmount,
          6
        )} IDRP`
      );

      const largeRule = await controller.getQuorumRule(
        OperationType.Freeze,
        largeAmount
      );

      console.log(
        "Required roles:",
        largeRule.requiredRoles
          .map((r) =>
            r === OFFICER_ROLE
              ? "OFFICER_ROLE"
              : r === MANAGER_ROLE
              ? "MANAGER_ROLE"
              : r === DIRECTOR_ROLE
              ? "DIRECTOR_ROLE"
              : r === COMMISSIONER_ROLE
              ? "COMMISSIONER_ROLE"
              : "Unknown"
          )
          .join(", ")
      );
      console.log(
        "Min amount:",
        hre.ethers.formatUnits(largeRule.minAmount, 6)
      );
      console.log(
        "Max amount:",
        hre.ethers.formatUnits(largeRule.maxAmount, 6)
      );

      expect(largeRule.requiredRoles.length).to.equal(4);
      expect(largeRule.requiredRoles).to.include(OFFICER_ROLE);
      expect(largeRule.requiredRoles).to.include(MANAGER_ROLE);
      expect(largeRule.requiredRoles).to.include(DIRECTOR_ROLE);
      expect(largeRule.requiredRoles).to.include(COMMISSIONER_ROLE);
    });
  });
});

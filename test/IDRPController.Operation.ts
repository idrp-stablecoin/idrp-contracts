import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPController - Operation Tests", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("MANAGER_ROLE")
  );

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6);

  async function deployFixture() {
    const [admin, officer, manager, user1, user2, depository] =
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

    await idrp.grantRole(await idrp.MINTER_ROLE(), controller.getAddress());
    await idrp.grantRole(await idrp.FREEZER_ROLE(), controller.getAddress());

    // Set quorum rules
    await controller.setQuorumRules(OperationType.Mint, [
      {
        minAmount: 0,
        maxAmount: ONE_HUNDRED_MILLION,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

    await controller.setQuorumRules(OperationType.Freeze, [
      {
        minAmount: 0,
        maxAmount: ONE_HUNDRED_MILLION,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      user1,
      user2,
      depository,
      domain,
      types,
    };
  }

  describe("Operation Nonce Validation", function () {
    it("Should prevent executing two operations with same arguments (including operationIdentifier) but different signatures (diff signers)", async function () {
      const { controller, officer, manager, user1, domain, types } =
        await loadFixture(deployFixture);

      const currentNonce = 1;
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      const firstOperation = {
        to: user1.address,
        operationType: OperationType.Freeze,
        amount: hre.ethers.parseUnits("0", 6), // Amount doesn't matter for freeze
        operationIdentifier: currentNonce.toString(),
        deadline: deadline,
      };

      const secondOperation = {
        to: user1.address,
        operationType: OperationType.Freeze,
        amount: hre.ethers.parseUnits("0", 6),
        operationIdentifier: currentNonce.toString(), // Same nonce!
        deadline: deadline,
      };

      const signatureForFirst = await officer.signTypedData(
        domain,
        types,
        firstOperation
      );
      console.log("signatureForFirst", signatureForFirst);

      const signatureForSecond = await manager.signTypedData(
        domain,
        types,
        secondOperation
      );
      console.log("signatureForSecond", signatureForSecond);

      await controller.executeOperation(
        firstOperation.operationType,
        firstOperation.to,
        firstOperation.amount,
        firstOperation.operationIdentifier,
        firstOperation.deadline,
        [signatureForFirst]
      );

      await expect(
        controller.executeOperation(
          secondOperation.operationType,
          secondOperation.to,
          secondOperation.amount,
          secondOperation.operationIdentifier,
          secondOperation.deadline,
          [signatureForSecond]
        )
      ).to.be.revertedWith("Operation hash already used");
    });
  });
});

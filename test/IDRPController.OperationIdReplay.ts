import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// One operationIdentifier, executed twice: the replay key used to be the EIP-712
// digest, and the digest includes the deadline. Re-signing the same identifier
// under a later deadline therefore produced a hash usedSignatures had never
// seen, and the operation ran a second time.
describe("IDRPController - operationIdentifier replay", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  async function deployFixture() {
    const [admin, officer, user1, depository] = await hre.ethers.getSigners();

    const idrp = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRP"),
      [admin.address]
    );
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controller.waitForDeployment();
    await idrp.connect(admin).setController(await controller.getAddress());

    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);

    const anyAmount = {
      minAmount: 0,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: [OFFICER_ROLE],
    };
    await controller.setQuorumRules(OperationType.Mint, [anyAmount]);
    await controller.setQuorumRules(OperationType.Freeze, [anyAmount]);

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

    return { idrp, controller, admin, officer, user1, depository, domain, types };
  }

  // One identifier, one quorum, two deadlines.
  it("rejects a second mint under the same identifier with a fresh deadline", async function () {
    const { idrp, controller, officer, depository, domain, types } =
      await loadFixture(deployFixture);

    const identifier = "0d1c4b7a-9e52-4f38-8c61-2ab7d90e5f43";
    const amount = hre.ethers.parseUnits("1000000", 6);
    const now = await time.latest();

    const sign = async (deadline: number) =>
      officer.signTypedData(domain, types, {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount,
        operationIdentifier: identifier,
        deadline,
      });

    const firstDeadline = now + 3600;
    const secondDeadline = firstDeadline + 608;

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      amount,
      identifier,
      firstDeadline,
      [await sign(firstDeadline)]
    );

    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        identifier,
        secondDeadline,
        [await sign(secondDeadline)]
      )
    ).to.be.revertedWith("Operation identifier already used");

    expect(await idrp.balanceOf(depository.address)).to.equal(amount);
  });

  // Same identifier, different operation: still one execution only. A reset
  // that changes the amount must not become a second mint either.
  it("rejects reuse of an identifier even when the operation differs", async function () {
    const { controller, officer, user1, domain, types } = await loadFixture(
      deployFixture
    );

    const identifier = "reset-keeps-the-id";
    const now = await time.latest();
    const deadline = now + 3600;

    const mintAmount = hre.ethers.parseUnits("1000", 6);
    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      mintAmount,
      identifier,
      deadline,
      [
        await officer.signTypedData(domain, types, {
          to: hre.ethers.ZeroAddress,
          operationType: OperationType.Mint,
          amount: mintAmount,
          operationIdentifier: identifier,
          deadline,
        }),
      ]
    );

    const freeze = {
      to: user1.address,
      operationType: OperationType.Freeze,
      amount: 0n,
      operationIdentifier: identifier,
      deadline,
    };

    await expect(
      controller.executeOperation(
        OperationType.Freeze,
        user1.address,
        0n,
        identifier,
        deadline,
        [await officer.signTypedData(domain, types, freeze)]
      )
    ).to.be.revertedWith("Operation identifier already used");
  });

  it("reports identifier use through a view, for the dashboard's pre-check", async function () {
    const { controller, officer, domain, types } = await loadFixture(
      deployFixture
    );

    const identifier = "view-check";
    const amount = hre.ethers.parseUnits("5", 6);
    const deadline = (await time.latest()) + 3600;

    expect(await controller.isOperationIdentifierUsed(identifier)).to.equal(
      false
    );

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      amount,
      identifier,
      deadline,
      [
        await officer.signTypedData(domain, types, {
          to: hre.ethers.ZeroAddress,
          operationType: OperationType.Mint,
          amount,
          operationIdentifier: identifier,
          deadline,
        }),
      ]
    );

    expect(await controller.isOperationIdentifierUsed(identifier)).to.equal(
      true
    );
  });
});

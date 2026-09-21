import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * THE GUARD ON THE LINEAGE TRON MAINNET ACTUALLY RUNS.
 *
 * Tron mainnet's controller is the v2 lineage: it has no AccessControl-default-
 * admin-rules and no quorum timelock, so the v3 branch cannot be shipped there
 * without a migration. Rather than gate a replay fix behind that migration, the
 * same guard is applied to `legacy/IDRPControllerv2.sol` — the source the
 * deployed implementation was built from.
 *
 * The point of this file is that the guard behaves identically on that lineage,
 * and that the fix needs no storage: the layout is unchanged, so the proxy can
 * still be upgraded afterwards.
 */
describe("IDRPControllerv2 - identifier guard on the deployed Tron lineage", function () {
  const ROLE = (name: string) =>
    hre.ethers.keccak256(hre.ethers.toUtf8Bytes(name));
  const OFFICER_ROLE = ROLE("OFFICER_ROLE");
  const MINTER_ROLE = ROLE("MINTER_ROLE");

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  async function deployFixture() {
    const [admin, officer, depository] = await hre.ethers.getSigners();

    const idrp = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPv2"),
      [admin.address],
    );
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPControllerv2"),
      [await idrp.getAddress(), admin.address],
    );
    await controller.waitForDeployment();

    // v2 wiring: the controller mints through MINTER_ROLE on the token.
    await idrp
      .connect(admin)
      .grantRole(MINTER_ROLE, await controller.getAddress());
    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await controller.connect(admin).setQuorumRules(OperationType.Mint, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

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

    return { idrp, controller, admin, officer, depository, domain, types };
  }

  const AMOUNT = hre.ethers.parseUnits("1000000", 6);

  /**
   * "Missing signature for role: <role>" concatenates a raw bytes32 into the
   * revert string, so it is not valid UTF-8 and chai's matcher cannot decode it.
   * The revert is real; this asserts it without reading the reason.
   */
  async function expectRevert(promise: Promise<unknown>) {
    let threw = false;
    try {
      await promise;
    } catch {
      threw = true;
    }
    expect(threw, "expected the call to revert").to.equal(true);
  }

  async function sign(
    officer: any,
    domain: any,
    types: any,
    identifier: string,
    deadline: number | bigint,
  ) {
    return officer.signTypedData(domain, types, {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: AMOUNT,
      operationIdentifier: identifier,
      deadline,
    });
  }

  it("refuses a second execution under the same identifier with a fresh deadline", async function () {
    const { idrp, controller, officer, depository, domain, types } =
      await loadFixture(deployFixture);

    const identifier = "0d1c4b7a-9e52-4f38-8c61-2ab7d90e5f43";
    const first = (await time.latest()) + 3600;
    const second = first + 608;

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      AMOUNT,
      identifier,
      first,
      [await sign(officer, domain, types, identifier, first)],
    );

    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        AMOUNT,
        identifier,
        second,
        [await sign(officer, domain, types, identifier, second)],
      ),
    ).to.be.revertedWith("Operation identifier already used");

    expect(await idrp.balanceOf(depository.address)).to.equal(AMOUNT);
  });

  it("records the identifier and no longer records the digest", async function () {
    const { controller, officer, domain, types } =
      await loadFixture(deployFixture);

    const identifier = "records-identifier-only";
    const deadline = (await time.latest()) + 3600;

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      AMOUNT,
      identifier,
      deadline,
      [await sign(officer, domain, types, identifier, deadline)],
    );

    const identifierKey = hre.ethers.keccak256(
      hre.ethers.toUtf8Bytes(identifier),
    );
    const digest = await controller.getOperationHash(
      hre.ethers.ZeroAddress,
      OperationType.Mint,
      AMOUNT,
      identifier,
      deadline,
    );

    expect(await controller.usedSignatures(identifierKey)).to.equal(true);
    expect(await controller.usedSignatures(digest)).to.equal(false);
  });

  it("leaves the identifier unspent when an execution reverts", async function () {
    const { controller, officer, domain, types } =
      await loadFixture(deployFixture);

    const identifier = "reverted-stays-open";
    const deadline = (await time.latest()) + 3600;
    const identifierKey = hre.ethers.keccak256(
      hre.ethers.toUtf8Bytes(identifier),
    );

    // Signed by an account with no role: the quorum cannot be satisfied.
    const [, , , outsider] = await hre.ethers.getSigners();
    await expectRevert(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        AMOUNT,
        identifier,
        deadline,
        [await sign(outsider, domain, types, identifier, deadline)],
      ),
    );

    expect(await controller.usedSignatures(identifierKey)).to.equal(false);

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      AMOUNT,
      identifier,
      deadline,
      [await sign(officer, domain, types, identifier, deadline)],
    );
    expect(await controller.usedSignatures(identifierKey)).to.equal(true);
  });
});

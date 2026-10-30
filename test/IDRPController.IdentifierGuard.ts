import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * IDENTIFIER GUARD — the edges.
 *
 * The identifier is now the only thing that decides whether an operation may
 * execute, so this file works through what that does and does NOT cover: what a
 * failed attempt leaves behind, which strings count as the same identifier, and
 * what the contract cannot see at all.
 */
describe("IDRPController - identifier guard edges", function () {
  const ROLE = (name: string) =>
    hre.ethers.keccak256(hre.ethers.toUtf8Bytes(name));
  const OFFICER_ROLE = ROLE("OFFICER_ROLE");
  const MANAGER_ROLE = ROLE("MANAGER_ROLE");
  const DIRECTOR_ROLE = ROLE("DIRECTOR_ROLE");

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  async function deployFixture() {
    const [admin, officer, manager, director, user1, depository] =
      await hre.ethers.getSigners();

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
    await controller.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await controller.connect(admin).grantRole(DIRECTOR_ROLE, director.address);

    const officerOnly = {
      minAmount: 0,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: [OFFICER_ROLE],
    };
    // Two roles, to exercise a quorum that can be left incomplete.
    const officerAndManager = {
      minAmount: 0,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
    };

    await controller.setQuorumRules(OperationType.Mint, [officerOnly]);
    await controller.setQuorumRules(OperationType.Burn, [officerAndManager]);
    await controller.setQuorumRules(OperationType.Freeze, [officerOnly]);
    await controller.setQuorumRules(OperationType.Unfreeze, [officerOnly]);
    await controller.setQuorumRules(OperationType.Pause, [officerOnly]);
    await controller.setQuorumRules(OperationType.Unpause, [officerOnly]);

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

    const sign = (
      signer: any,
      op: {
        to: string;
        operationType: number;
        amount: bigint;
        operationIdentifier: string;
        deadline: number | bigint;
      }
    ) => signer.signTypedData(domain, types, op);

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      director,
      user1,
      depository,
      domain,
      types,
      sign,
    };
  }

  const MILLION = hre.ethers.parseUnits("1000000", 6);

  /**
   * "Missing signature for role: <role>" concatenates a raw bytes32 into the
   * revert string, so the result is not valid UTF-8 and chai's matcher cannot
   * decode it. The revert itself is fine — this just asserts it happened without
   * asking for the reason to be readable.
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

  // ── What a failed attempt leaves behind ──────────────────────────────────

  it("an execution that reverts does NOT consume the identifier", async function () {
    const { controller, officer, manager, depository, sign } =
      await loadFixture(deployFixture);

    const id = "burn-retry";
    const deadline = (await time.latest()) + 3600;

    // Fund the depository first: the token only burns from the controller or
    // the depository wallet.
    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      MILLION,
      "fund-the-depository",
      deadline,
      [
        await sign(officer, {
          to: hre.ethers.ZeroAddress,
          operationType: OperationType.Mint,
          amount: MILLION,
          operationIdentifier: "fund-the-depository",
          deadline,
        }),
      ]
    );

    const op = {
      to: depository.address,
      operationType: OperationType.Burn,
      amount: MILLION,
      operationIdentifier: id,
      deadline,
    };

    // Burn needs officer AND manager: one signature is an incomplete quorum.
    await expectRevert(
      controller.executeOperation(
        OperationType.Burn,
        depository.address,
        MILLION,
        id,
        deadline,
        [await sign(officer, op)]
      )
    );

    expect(await controller.isOperationIdentifierUsed(id)).to.equal(false);

    // The same identifier still works once the quorum is complete — a failed
    // attempt must not strand a legitimate operation.
    await controller.executeOperation(
      OperationType.Burn,
      depository.address,
      MILLION,
      id,
      deadline,
      [await sign(officer, op), await sign(manager, op)]
    );
    expect(await controller.isOperationIdentifierUsed(id)).to.equal(true);
  });

  it("an expired deadline is refused and does NOT consume the identifier", async function () {
    const { controller, officer, sign } = await loadFixture(deployFixture);

    const id = "expired-then-retried";
    const deadline = (await time.latest()) + 3600;
    const signature = await sign(officer, {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: MILLION,
      operationIdentifier: id,
      deadline,
    });

    await time.increaseTo(deadline + 1);

    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        MILLION,
        id,
        deadline,
        [signature]
      )
    ).to.be.revertedWith("Operation expired");
    expect(await controller.isOperationIdentifierUsed(id)).to.equal(false);

    // Re-signed under a fresh deadline, the same identifier still executes —
    // which is the legitimate case a reset exists for.
    const newDeadline = (await time.latest()) + 3600;
    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      MILLION,
      id,
      newDeadline,
      [
        await sign(officer, {
          to: hre.ethers.ZeroAddress,
          operationType: OperationType.Mint,
          amount: MILLION,
          operationIdentifier: id,
          deadline: newDeadline,
        }),
      ]
    );
    expect(await controller.isOperationIdentifierUsed(id)).to.equal(true);
  });

  // ── One identifier, one execution, whatever else changes ─────────────────

  it("blocks a second execution when only the target changes", async function () {
    const { controller, officer, user1, manager, sign } = await loadFixture(
      deployFixture
    );

    const id = "target-swap";
    const deadline = (await time.latest()) + 3600;

    await controller.executeOperation(
      OperationType.Freeze,
      user1.address,
      0n,
      id,
      deadline,
      [
        await sign(officer, {
          to: user1.address,
          operationType: OperationType.Freeze,
          amount: 0n,
          operationIdentifier: id,
          deadline,
        }),
      ]
    );

    await expect(
      controller.executeOperation(
        OperationType.Freeze,
        manager.address,
        0n,
        id,
        deadline,
        [
          await sign(officer, {
            to: manager.address,
            operationType: OperationType.Freeze,
            amount: 0n,
            operationIdentifier: id,
            deadline,
          }),
        ]
      )
    ).to.be.revertedWith("Operation identifier already used");
  });

  it("blocks the unpause path too, where the checks used to live separately", async function () {
    const { controller, idrp, officer, manager, director, sign } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;

    await controller.executeOperation(
      OperationType.Pause,
      hre.ethers.ZeroAddress,
      0n,
      "pause-once",
      deadline,
      [
        await sign(officer, {
          to: hre.ethers.ZeroAddress,
          operationType: OperationType.Pause,
          amount: 0n,
          operationIdentifier: "pause-once",
          deadline,
        }),
      ]
    );
    expect(await idrp.paused()).to.equal(true);

    // Unpause needs officer + manager + director together.
    const unpauseOp = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Unpause,
      amount: 0n,
      operationIdentifier: "unpause-once",
      deadline,
    };
    const unpauseSigs = [
      await sign(officer, unpauseOp),
      await sign(manager, unpauseOp),
      await sign(director, unpauseOp),
    ];

    await controller.executeOperation(
      OperationType.Unpause,
      hre.ethers.ZeroAddress,
      0n,
      "unpause-once",
      deadline,
      unpauseSigs
    );
    expect(await idrp.paused()).to.equal(false);

    // Pause again so a replayed unpause would otherwise have something to do.
    await controller.executeOperation(
      OperationType.Pause,
      hre.ethers.ZeroAddress,
      0n,
      "pause-twice",
      deadline,
      [
        await sign(officer, {
          to: hre.ethers.ZeroAddress,
          operationType: OperationType.Pause,
          amount: 0n,
          operationIdentifier: "pause-twice",
          deadline,
        }),
      ]
    );

    await expect(
      controller.executeOperation(
        OperationType.Unpause,
        hre.ethers.ZeroAddress,
        0n,
        "unpause-once",
        deadline,
        unpauseSigs
      )
    ).to.be.revertedWith("Operation identifier already used");
    expect(await idrp.paused()).to.equal(true);
  });

  // ── Which strings count as the same identifier ───────────────────────────

  it("treats case and whitespace variants as DIFFERENT identifiers", async function () {
    const { controller, officer, sign } = await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const variants = ["op-42", "OP-42", "op-42 ", " op-42"];

    // Every variant executes: the contract compares bytes, nothing else. Any
    // normalising — trimming, lower-casing — has to happen before this point.
    for (const id of variants) {
      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        MILLION,
        id,
        deadline,
        [
          await sign(officer, {
            to: hre.ethers.ZeroAddress,
            operationType: OperationType.Mint,
            amount: MILLION,
            operationIdentifier: id,
            deadline,
          }),
        ]
      );
      expect(await controller.isOperationIdentifierUsed(id)).to.equal(true);
    }
    expect(await controller.isOperationIdentifierUsed("op-42")).to.equal(true);
  });

  it("refuses an empty identifier outright", async function () {
    const { controller, officer, sign } = await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const op = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: MILLION,
      operationIdentifier: "",
      deadline,
    };

    // An empty identifier identifies nothing, and one execution would consume
    // keccak("") for good — every later empty-identifier operation would then
    // revert. Polygon carries two such executions from before this guard.
    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        MILLION,
        "",
        deadline,
        [await sign(officer, op)]
      )
    ).to.be.revertedWith("Operation identifier required");

    expect(await controller.isOperationIdentifierUsed("")).to.equal(false);
  });

  // ── What the contract cannot see ─────────────────────────────────────────

  it("cannot tell that a NEW identifier means the same business operation", async function () {
    const { controller, officer, sign } = await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amount = MILLION;

    for (const id of ["invoice-7", "invoice-7-retry"]) {
      await controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        id,
        deadline,
        [
          await sign(officer, {
            to: hre.ethers.ZeroAddress,
            operationType: OperationType.Mint,
            amount,
            operationIdentifier: id,
            deadline,
          }),
        ]
      );
    }

    // Both executed. Identical terms, two identifiers, two mints — the chain has
    // no idea they were the same intent. Re-issuing an identifier for work that
    // already ran is therefore a platform-side mistake the contract cannot catch,
    // which is why the reset path asks the chain before minting a new one.
    expect(await controller.isOperationIdentifierUsed("invoice-7")).to.equal(
      true
    );
    expect(
      await controller.isOperationIdentifierUsed("invoice-7-retry")
    ).to.equal(true);
  });

  it("keeps identifiers independent per controller, so one chain cannot spend another's", async function () {
    const { controller, idrp, admin, officer, sign } = await loadFixture(
      deployFixture
    );

    const second = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await second.waitForDeployment();
    await second.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await second.setQuorumRules(OperationType.Mint, [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE],
      },
    ]);

    const id = "shared-identifier";
    const deadline = (await time.latest()) + 3600;
    const op = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: MILLION,
      operationIdentifier: id,
      deadline,
    };

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      MILLION,
      id,
      deadline,
      [await sign(officer, op)]
    );

    expect(await controller.isOperationIdentifierUsed(id)).to.equal(true);
    // Spent on one controller, untouched on the other: the record is per
    // contract, exactly like the signatures, which bind to a domain.
    expect(await second.isOperationIdentifierUsed(id)).to.equal(false);
  });

  it("will not accept a signature made for a different identifier", async function () {
    const { controller, officer, sign } = await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const signedForOther = await sign(officer, {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: MILLION,
      operationIdentifier: "identifier-A",
      deadline,
    });

    // Submitted under identifier-B, the signature recovers a different address,
    // which holds no role.
    await expectRevert(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        MILLION,
        "identifier-B",
        deadline,
        [signedForOther]
      )
    );
    expect(await controller.isOperationIdentifierUsed("identifier-B")).to.equal(
      false
    );
  });
});

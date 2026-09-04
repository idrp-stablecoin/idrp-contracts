import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import rulesConfiscate from "../utils/rules.confiscate.json";
import { deployIDRPControllerV3ForTests } from "../utils/utils";

/**
 * confiscate(from, amount) — seize a frozen account's balance, now authorised
 * by the Controller's EIP-712 quorum instead of the admin multisig.
 *
 * THE AUTHORITY CHANGE under test: confiscate moved from IDRP.onlyAdmin to
 * IDRP.onlyController, reachable only via
 *   controller.executeOperation(OperationType.Confiscate, victim, amount, ...)
 * with real signatures from ALL FOUR roles — Officer, Manager, Director,
 * Commissioner (test/utils/rules.confiscate.json: a single top tier covering
 * any amount, so `amount` cannot select a weaker requirement). The result is
 * two controls that are no longer fully independent: the quorum authorises WHO
 * gets seized and how much, while admin alone controls WHERE it goes, because
 * the destination is now `depositoryWallet` and `setDepositoryWallet` is
 * onlyAdmin and INSTANT. The separate destination slot and its 48h timelock
 * were removed deliberately; what remains is that admin cannot authorise a
 * seizure and the quorum cannot redirect one.
 *
 * Design invariants under test (unchanged from the admin-gated version — only
 * the AUTHORITY changed, not the seizure mechanics):
 *  - Freeze is a HARD precondition. Seizure is always freeze → confiscate, so
 *    there is a public AccountFrozen event before any funds move.
 *  - The target STAYS frozen afterwards, so residue and incoming funds remain
 *    immobilized.
 *  - The destination is storage, never a caller argument — the Confiscate
 *    dispatch branch in executeOperation passes only (victim, amount); there
 *    is no destination parameter and no OPERATION_TYPEHASH change.
 *  - Total supply is unchanged. A seizure is a transfer, never a burn — wrongly
 *    seized funds have to be returnable, and burning would unwind peg
 *    accounting (supply drops while the fiat reserve does not).
 *  - `amount` IS the effect, and the quorum rule is single-tier/any-amount, so
 *    `amount` selects nothing — confiscate is structurally immune to the
 *    quorum-tier-bypass finding (test/security-audit/quorum-tier-bypass/).
 *
 * New invariants introduced by the authority change itself:
 *  - An incomplete quorum (missing any of the four required roles) is rejected.
 *  - Signatures collected for a different operation do not authorise this one.
 *  - A used operation hash cannot be replayed.
 *  - Direct calls to IDRP.confiscate — by admin, by upgrader, by any address
 *    that is not the wired controller — revert NotController. There is no
 *    path to a seizure that skips the quorum.
 */
describe("Confiscate — confiscate(from, amount) via the Controller quorum", function () {
  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  const SEIZED_BALANCE = idrp6("4000000000"); // 4B IDRP

  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE"));

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
    Confiscate,
  }

  /**
   * Deploys IDRP + IDRPController wired production-style (idrp.controller ==
   * the real Controller proxy), grants all four quorum roles, seeds the
   * Confiscate quorum rule from test/utils/rules.confiscate.json, and funds
   * `badActor` with SEIZED_BALANCE. Leaves the depository pointed at
   * `depository` and does NOT freeze anyone — see deployFixture/frozenFixture.
   */
  async function baseFixture() {
    const [admin, depository, seizedFunds, badActor, other, officer, manager, director, commissioner] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controller.waitForDeployment();
    const controllerAddress = await controller.getAddress();

    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await controller.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await controller.connect(admin).grantRole(DIRECTOR_ROLE, director.address);
    await controller.connect(admin).grantRole(COMMISSIONER_ROLE, commissioner.address);

    // Confiscate has never been configured, so quorumRules[Confiscate].length
    // == 0 and setQuorumRules takes the INSTANT path — a single un-timelocked
    // tx, per test/utils/rules.README.md. This is seeding a brand-new op
    // type, not changing an existing one (that path IS timelocked).
    await controller.connect(admin).setQuorumRules(OperationType.Confiscate, rulesConfiscate);

    // Fund the bad actor via a temporary direct wiring, then wire the real
    // controller for production-shaped confiscate calls. See
    // test/utils/utils.ts's deployIDRPControllerV3ForTests doc comment for
    // this "flip to a direct signer, then back" convention.
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(SEIZED_BALANCE);
    await idrp.connect(depository).transfer(badActor.address, SEIZED_BALANCE);
    await idrp.connect(admin).setController(controllerAddress);

    const domain = {
      name: "IDRPController",
      version: "1",
      chainId: 31337,
      verifyingContract: controllerAddress,
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

    let opCounter = 0;
    async function buildOp(to: string, amount: bigint, operationIdentifier?: string) {
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      opCounter++;
      return {
        to,
        operationType: OperationType.Confiscate,
        amount,
        operationIdentifier: operationIdentifier ?? `confiscate-op-${opCounter}`,
        deadline: now + 3600,
      };
    }

    async function signOp(op: Awaited<ReturnType<typeof buildOp>>, signers: typeof officer[]) {
      return Promise.all(signers.map((s) => s.signTypedData(domain, types, op)));
    }

    /**
     * Runs a full quorum-authorised Confiscate through the real controller.
     * Defaults to the honest four-signature quorum, submitted by officer.
     * Override `signers`/`submitter` to probe partial or wrong-role quorums.
     */
    async function executeConfiscate(
      to: string,
      amount: bigint,
      opts?: { signers?: typeof officer[]; submitter?: typeof officer; operationIdentifier?: string }
    ) {
      const signers = opts?.signers ?? [officer, manager, director, commissioner];
      const submitter = opts?.submitter ?? officer;
      const op = await buildOp(to, amount, opts?.operationIdentifier);
      const sigs = await signOp(op, signers);
      return controller
        .connect(submitter)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, sigs);
    }

    /** Runs `action` with idrp.controller temporarily flipped to `admin` — setup plumbing only. */
    async function withDirectController<T>(action: () => Promise<T>): Promise<T> {
      await idrp.connect(admin).setController(admin.address);
      const result = await action();
      await idrp.connect(admin).setController(controllerAddress);
      return result;
    }

    /** Freezes `target` directly. Freeze's OWN quorum gating is covered elsewhere
     *  (e.g. test/security-audit/quorum-tier-bypass/QTB-01-AmountTierBypass.ts) —
     *  here it is just the precondition confiscate needs. */
    async function freezeDirectly(target: string) {
      return withDirectController(() => idrp.connect(admin).freeze(target));
    }

    return {
      idrp,
      controller,
      controllerAddress,
      admin,
      depository,
      seizedFunds,
      badActor,
      other,
      officer,
      manager,
      director,
      commissioner,
      domain,
      types,
      buildOp,
      signOp,
      executeConfiscate,
      withDirectController,
      freezeDirectly,
    };
  }

  /**
   * baseFixture + the depository moved to `seizedFunds`, which is therefore the
   * seizure destination too. Moving it AFTER badActor is funded keeps
   * `seizedFunds` at a zero starting balance, so `balanceOf(seizedFunds)` reads
   * as "total seized" throughout this suite. `depository` keeps the leftover
   * mint and is used below as an ordinary unfrozen counterparty.
   */
  async function deployFixture() {
    const ctx = await baseFixture();
    await ctx.idrp.connect(ctx.admin).setDepositoryWallet(ctx.seizedFunds.address);
    return ctx;
  }

  /** deployFixture + badActor frozen. The shape almost every test needs. */
  async function frozenFixture() {
    const ctx = await loadFixture(deployFixture);
    await ctx.freezeDirectly(ctx.badActor.address);
    return ctx;
  }

  it("seizes the full balance of a frozen account to the confiscation wallet", async function () {
    const { idrp, seizedFunds, badActor, executeConfiscate } = await frozenFixture();

    await expect(executeConfiscate(badActor.address, SEIZED_BALANCE))
      .to.emit(idrp, "AssetsConfiscated")
      .withArgs(badActor.address, seizedFunds.address, SEIZED_BALANCE);

    expect(await idrp.balanceOf(badActor.address)).to.equal(0n);
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);
  });

  it("emits a single direct Transfer from the target to the destination, not a burn+mint pair", async function () {
    // A burn+mint implementation would report a seizure as two unrelated
    // events and destroy the trail an auditor or a disputing user has to
    // follow. `.to.emit().withArgs()` only proves a matching Transfer
    // occurred (it does not bound the count), so we additionally assert
    // exactly one Transfer log in the receipt to rule out a burn(from)+
    // mint(destination) pair.
    const { idrp, seizedFunds, badActor, executeConfiscate } = await frozenFixture();
    const tx = await executeConfiscate(badActor.address, SEIZED_BALANCE);
    await expect(tx)
      .to.emit(idrp, "Transfer")
      .withArgs(badActor.address, seizedFunds.address, SEIZED_BALANCE);

    const receipt = await tx.wait();
    const transferTopic = idrp.interface.getEvent("Transfer").topicHash;
    const transferLogs = receipt!.logs.filter((log) => log.topics[0] === transferTopic);
    expect(transferLogs.length).to.equal(1);
  });

  it("leaves total supply unchanged", async function () {
    const { idrp, badActor, executeConfiscate } = await frozenFixture();
    const before = await idrp.totalSupply();
    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.totalSupply()).to.equal(before);
  });

  it("reverts a seizure naming less than the full balance", async function () {
    // Partial seizure through the quorum is closed: `amount` is both the tier
    // selector and the effect, so under-naming it would let a signer land in
    // a cheap tier and repeat the seizure in slices. The token layer still
    // accepts a partial amount (see IDRP.confiscate) — this guard lives in
    // the Controller, one level up.
    const { badActor, executeConfiscate } = await frozenFixture();
    const part = SEIZED_BALANCE - 1n;
    await expect(
      executeConfiscate(badActor.address, part)
    ).to.be.revertedWith("amount below target balance");
  });

  it("seizes exactly the full balance through the quorum", async function () {
    const { idrp, seizedFunds, badActor, executeConfiscate } = await frozenFixture();
    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.balanceOf(badActor.address)).to.equal(0n);
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);
  });

  // Two contiguous tiers spanning 0..max — deliberately NOT the production
  // single-tier shape, reused by both tests below.
  const twoTierRules = [
    { minAmount: 0n, maxAmount: SEIZED_BALANCE, requiredRoles: rulesConfiscate[0].requiredRoles },
    {
      minAmount: SEIZED_BALANCE,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: rulesConfiscate[0].requiredRoles,
    },
  ];

  it("rejects a second Confiscate tier at seeding time, via setQuorumRules", async function () {
    // _validateQuorumRules enforces single-tier for Confiscate — fail fast at
    // write time rather than letting a bad config sit until a seizure is
    // attempted mid-incident. Uses a bare fresh deployment (no fixtures here
    // seed Confiscate rules yet), so setQuorumRules takes the instant
    // first-time path and reaches _validateQuorumRules directly.
    const [admin] = await hre.ethers.getSigners();
    const { controller } = await deployIDRPControllerV3ForTests(admin);
    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Confiscate, twoTierRules)
    ).to.be.revertedWith("Confiscate must be single-tier");
  });

  it("rejects a second Confiscate tier at seeding time, via scheduleQuorumRules", async function () {
    // Same guard on the timelocked change path — a second tier must never
    // even reach `pendingQuorumRules`.
    const { admin, controller } = await frozenFixture();
    await expect(
      controller.connect(admin).scheduleQuorumRules(OperationType.Confiscate, twoTierRules)
    ).to.be.revertedWith("Confiscate must be single-tier");
  });

  it("executeOperation's single-tier assert is a live backstop, not dead code", async function () {
    // With write-time validation in place, no real entry point can ever
    // leave quorumRules[Confiscate].length != 1 — so this test deploys
    // IDRPControllerConfiscateBackstopMock, a harness that writes
    // `quorumRules` directly (bypassing _validateQuorumRules entirely, the
    // way a future write path might if it forgot to validate), to prove the
    // execute-time require in executeOperation still holds.
    const [freshAdmin, depository, , freshBadActor, , freshOfficer, freshManager, freshDirector, freshCommissioner] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const freshIdrp = await hre.upgrades.deployProxy(IDRPFactory, [freshAdmin.address]);
    await freshIdrp.waitForDeployment();
    await freshIdrp.connect(freshAdmin).setDepositoryWallet(depository.address);

    const freshController = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPControllerConfiscateBackstopMock"),
      [await freshIdrp.getAddress(), freshAdmin.address]
    );
    await freshController.waitForDeployment();
    const freshControllerAddress = await freshController.getAddress();

    await freshController.connect(freshAdmin).grantRole(OFFICER_ROLE, freshOfficer.address);
    await freshController.connect(freshAdmin).grantRole(MANAGER_ROLE, freshManager.address);
    await freshController.connect(freshAdmin).grantRole(DIRECTOR_ROLE, freshDirector.address);
    await freshController.connect(freshAdmin).grantRole(COMMISSIONER_ROLE, freshCommissioner.address);

    // Bypass validation entirely via the harness's raw setter.
    await freshController.connect(freshAdmin).seedQuorumRulesRaw(OperationType.Confiscate, twoTierRules);

    await freshIdrp.connect(freshAdmin).setController(freshAdmin.address);
    await freshIdrp.connect(freshAdmin).mint(SEIZED_BALANCE);
    await freshIdrp.connect(depository).transfer(freshBadActor.address, SEIZED_BALANCE);
    await freshIdrp.connect(freshAdmin).freeze(freshBadActor.address);
    await freshIdrp.connect(freshAdmin).setController(freshControllerAddress);

    const domain = {
      name: "IDRPController",
      version: "1",
      chainId: 31337,
      verifyingContract: freshControllerAddress,
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
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const op = {
      to: freshBadActor.address,
      operationType: OperationType.Confiscate,
      amount: SEIZED_BALANCE,
      operationIdentifier: "two-tier-confiscate-backstop",
      deadline: now + 3600,
    };
    const sigs = await Promise.all(
      [freshOfficer, freshManager, freshDirector, freshCommissioner].map((s) =>
        s.signTypedData(domain, types, op)
      )
    );

    await expect(
      freshController
        .connect(freshOfficer)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, sigs)
    ).to.be.revertedWith("Confiscate must be single-tier");
  });

  it("reverts on an account that is NOT frozen", async function () {
    const { idrp, badActor, executeConfiscate } = await loadFixture(deployFixture);
    await expect(
      executeConfiscate(badActor.address, SEIZED_BALANCE)
    ).to.be.revertedWithCustomError(idrp, "NotFrozen");
  });

  it("leaves the target FROZEN after a full seizure", async function () {
    const { idrp, badActor, executeConfiscate } = await frozenFixture();
    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.frozen(badActor.address)).to.equal(true);
  });

  it("leaves the target frozen after a full seizure, so nothing can move", async function () {
    // Partial seizure is no longer reachable through the quorum (see "reverts
    // a seizure naming less than the full balance" above), so this now
    // exercises the full-balance path — the target's balance is 0 afterwards,
    // and it stays frozen regardless.
    const { idrp, badActor, other, executeConfiscate } = await frozenFixture();
    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.frozen(badActor.address)).to.equal(true);
    await expect(
      idrp.connect(badActor).transfer(other.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("reverts when the depository wallet is unset", async function () {
    // `depositoryWallet` can never be returned to address(0) — setDepositoryWallet
    // rejects it — so this state exists only on a proxy that has never configured
    // one. That is exactly the state a chain is in the moment this upgrade lands,
    // which is what makes the guard worth pinning: confiscate must be inert, not
    // burn to address(0), before an operator configures a depository.
    const [admin, , , badActor] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).freeze(badActor.address);

    await expect(
      idrp.connect(admin).confiscate(badActor.address, 1n)
    ).to.be.revertedWith("Depository wallet not set");
  });

  it("reverts on a zero amount", async function () {
    // Target a zero-balance frozen account (`other`), not badActor: the
    // Controller's full-balance guard requires amount >= balance(to), and for
    // a nonzero balance a zero amount would revert THERE first. Zeroing the
    // target's balance lets 0 pass the Controller guard so the token-level
    // "Amount must be greater than zero" check is what's actually exercised.
    const { idrp, other, executeConfiscate, freezeDirectly } = await frozenFixture();
    await freezeDirectly(other.address);
    await expect(
      executeConfiscate(other.address, 0n)
    ).to.be.revertedWith("Amount must be greater than zero");
  });

  it("reverts when the amount exceeds the balance", async function () {
    const { idrp, badActor, executeConfiscate } = await frozenFixture();
    await expect(
      executeConfiscate(badActor.address, SEIZED_BALANCE + 1n)
    ).to.be.revertedWithCustomError(idrp, "ERC20InsufficientBalance");
  });

  it("reverts when the token is paused", async function () {
    const { idrp, badActor, executeConfiscate, withDirectController, admin } = await frozenFixture();
    await withDirectController(() => idrp.connect(admin).pause());
    await expect(
      executeConfiscate(badActor.address, SEIZED_BALANCE)
    ).to.be.revertedWithCustomError(idrp, "EnforcedPause");
  });

  it("refuses to confiscate from the depository itself", async function () {
    const { idrp, seizedFunds, badActor, executeConfiscate, freezeDirectly } = await frozenFixture();
    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    await freezeDirectly(seizedFunds.address);
    // Must name seizedFunds's full balance (SEIZED_BALANCE) — anything less
    // now reverts at the Controller's full-balance guard before ever reaching
    // the token-level "from != destination" check this test is targeting.
    //
    // The token checks `from != destination` before anything else that could
    // observe the destination's frozen state, which is what keeps this error
    // reachable: confiscate requires frozen[from], so on a self-seizure the
    // destination is frozen by construction.
    await expect(
      executeConfiscate(seizedFunds.address, SEIZED_BALANCE)
    ).to.be.revertedWith("Cannot confiscate from the depository");
  });

  it("re-enforces the freeze gate immediately after a confiscation", async function () {
    // Proves the bypass flag was cleared. If it stuck on, this transfer would
    // succeed and every freeze on the token would be silently unenforced.
    const { idrp, depository, badActor, other, executeConfiscate, freezeDirectly } = await frozenFixture();
    await executeConfiscate(badActor.address, SEIZED_BALANCE);

    await expect(
      idrp.connect(depository).transfer(badActor.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");

    await freezeDirectly(other.address);
    await expect(
      idrp.connect(other).transfer(depository.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("seizes from a SANCTIONED address — the sanctions gate must not block recovery", async function () {
    // No MockSanctionsList exists in this repo; contracts/sanctions/SanctionsList.sol
    // is IDRP's own Chainalysis-clone implementation, and is what production and
    // the rest of the confiscate/sanctions suites wire up directly (see
    // test/confiscate/UpdateBypass.ts and test/sanctions/IDRPSanctions.test.ts).
    const { idrp, admin, seizedFunds, badActor, executeConfiscate } = await frozenFixture();
    const List = await hre.ethers.getContractFactory("SanctionsList");
    const list = await List.deploy();
    await list.waitForDeployment();
    await list.connect(admin).addToSanctionsList([badActor.address]);
    await idrp.connect(admin).setSanctionsList(await list.getAddress());
    // Guard against a silent no-op on addToSanctionsList: without this, the
    // test would stay green even if the sender were never actually listed.
    expect(await list.isSanctioned(badActor.address)).to.equal(true);

    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);
  });

  it("seizes to a SANCTIONED depository — the bypass covers both legs, not just the sender", async function () {
    // _update's bypass skips the sanctions gate for both `from` and `to` while
    // _inConfiscation is set. This proves the destination leg is covered too,
    // so a future narrowing of the bypass to `from` only would fail here.
    const { idrp, admin, seizedFunds, badActor, executeConfiscate } = await frozenFixture();
    const List = await hre.ethers.getContractFactory("SanctionsList");
    const list = await List.deploy();
    await list.waitForDeployment();
    await list.connect(admin).addToSanctionsList([seizedFunds.address]);
    await idrp.connect(admin).setSanctionsList(await list.getAddress());
    expect(await list.isSanctioned(seizedFunds.address)).to.equal(true);

    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);
  });

  it("keeps the sanctions gate enforced on ordinary transfers afterwards", async function () {
    const { idrp, admin, depository, badActor, other, executeConfiscate } = await frozenFixture();
    const List = await hre.ethers.getContractFactory("SanctionsList");
    const list = await List.deploy();
    await list.waitForDeployment();
    await list.connect(admin).addToSanctionsList([other.address]);
    await idrp.connect(admin).setSanctionsList(await list.getAddress());

    await executeConfiscate(badActor.address, SEIZED_BALANCE);

    await expect(
      idrp.connect(depository).transfer(other.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "SanctionedRecipient");
  });

  it("reads the destination live from depositoryWallet — moving the depository moves where the next seizure lands", async function () {
    // Two things at once.
    //
    // The safe half: the destination is storage, read at call time, and is NOT
    // a parameter of executeOperation's Confiscate branch — a caller, even a
    // full honest quorum, cannot steer where funds go.
    //
    // The half worth staring at: admin CAN steer it, in one instant
    // setDepositoryWallet call, because that setter has no timelock. That is
    // precisely the property the removed 48h destination timelock used to
    // prevent, so it is pinned here in the suite rather than left in a doc.
    const { idrp, admin, depository, seizedFunds, badActor, other, executeConfiscate, freezeDirectly } =
      await frozenFixture();

    await executeConfiscate(badActor.address, SEIZED_BALANCE);
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);

    // Fund and freeze a second target out of the seized pile, then move the
    // depository to a different address entirely.
    await idrp.connect(seizedFunds).transfer(other.address, SEIZED_BALANCE);
    await freezeDirectly(other.address);
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    await executeConfiscate(other.address, SEIZED_BALANCE);

    expect(await idrp.balanceOf(depository.address)).to.equal(SEIZED_BALANCE);
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(0n);
  });

  // ───────────────────────────────────────────────────────────────────────
  // New invariants from the authority change: the quorum itself must hold.
  // ───────────────────────────────────────────────────────────────────────

  it("rejects an incomplete quorum — Officer + Manager only, when all four roles are required", async function () {
    const { idrp, badActor, officer, manager, executeConfiscate } = await frozenFixture();

    // Plain try/catch rather than chai's revert matchers: verifySignatures'
    // revert reason is abi.encodePacked("Missing signature for role: ", role)
    // — raw bytes32 appended to a string — which is not valid UTF-8 and
    // crashes hardhat-chai-matchers' revert-reason decoder. Assert on
    // resulting STATE instead, consistent with this suite's philosophy.
    let executed = true;
    try {
      await executeConfiscate(badActor.address, SEIZED_BALANCE, { signers: [officer, manager] });
    } catch {
      executed = false;
    }

    expect(executed, "an incomplete quorum (2 of 4 required roles) must not authorise a seizure").to.equal(false);
    expect(await idrp.balanceOf(badActor.address)).to.equal(SEIZED_BALANCE);
    expect(await idrp.frozen(badActor.address)).to.equal(true);
  });

  it("rejects signatures that were produced for a DIFFERENT operation", async function () {
    const { idrp, controller, badActor, other, officer, manager, director, commissioner, buildOp, signOp } =
      await frozenFixture();

    // Sign a confiscate op against a DIFFERENT target and operationIdentifier...
    const decoyOp = await buildOp(other.address, SEIZED_BALANCE, "decoy-operation");
    const decoySigs = await signOp(decoyOp, [officer, manager, director, commissioner]);

    // ...then try to redeem those signatures against the real op. Different
    // `to`/`operationIdentifier` means a different EIP-712 struct hash, so
    // ecrecover on THIS hash with those signature bytes will not recover any
    // of the four role holders. Same decode-crash reason as above for the
    // try/catch instead of a chai revert matcher.
    const realOp = await buildOp(badActor.address, SEIZED_BALANCE, "real-operation");
    let executed = true;
    try {
      await controller.executeOperation(
        realOp.operationType,
        realOp.to,
        realOp.amount,
        realOp.operationIdentifier,
        realOp.deadline,
        decoySigs
      );
    } catch {
      executed = false;
    }

    expect(executed, "signatures for a different operation must not authorise this one").to.equal(false);
    expect(await idrp.balanceOf(badActor.address)).to.equal(SEIZED_BALANCE);
    expect(await idrp.frozen(badActor.address)).to.equal(true);
  });

  it("rejects replay of the same operation hash", async function () {
    const { idrp, controller, seizedFunds, badActor, officer, manager, director, commissioner, domain, types } =
      await frozenFixture();

    // Built and signed once, replayed byte-for-byte — including `deadline` —
    // since the operation hash covers every field. A fresh buildOp() call per
    // execution would carry a different timestamp and not actually test replay.
    // Amount must be the full balance — anything less now reverts at the
    // Controller's full-balance guard before replay protection is ever reached.
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const op = {
      to: badActor.address,
      operationType: OperationType.Confiscate,
      amount: SEIZED_BALANCE,
      operationIdentifier: "confiscate-replay-op",
      deadline: now + 3600,
    };
    const sigs = await Promise.all(
      [officer, manager, director, commissioner].map((s) => s.signTypedData(domain, types, op))
    );

    await controller.executeOperation(
      op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, sigs
    );
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);

    await expect(
      controller.executeOperation(
        op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, sigs
      )
    ).to.be.revertedWith("Operation hash already used");

    // The replay must not have moved funds a second time.
    expect(await idrp.balanceOf(seizedFunds.address)).to.equal(SEIZED_BALANCE);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Direct calls to IDRP.confiscate — every path that skips the quorum.
  // ───────────────────────────────────────────────────────────────────────

  it("rejects a direct call from admin — confiscate is no longer admin-gated", async function () {
    const { idrp, admin, badActor } = await frozenFixture();
    await expect(
      idrp.connect(admin).confiscate(badActor.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "NotController");
  });

  it("rejects a direct call from upgrader", async function () {
    const { idrp, admin, badActor, other } = await frozenFixture();
    await idrp.connect(admin).setUpgrader(other.address);
    await expect(
      idrp.connect(other).confiscate(badActor.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "NotController");
  });

  it("rejects a direct call from a random EOA", async function () {
    const { idrp, badActor, other } = await frozenFixture();
    await expect(
      idrp.connect(other).confiscate(badActor.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "NotController");
  });
});

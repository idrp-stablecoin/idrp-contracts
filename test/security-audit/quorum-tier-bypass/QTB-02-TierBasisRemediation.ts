import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [QTB-02] IDRPController.executeOperation — remediation for the amount/tier
 *          bypass documented in QTB-01-AmountTierBypass.ts.
 *
 * QTB-01 must not be edited — it stays remediation-agnostic so it keeps
 * proving the invariant. This file pins down the SPECIFIC fix that was
 * chosen: Option F. See
 * ../notes/features/idrp-contracts/on-progress/quorum-tier-bypass/OPTIONS.md
 *
 * executeOperation derives `basis = max(amount, balanceOf(to))` for
 * Freeze/Unfreeze and selects the tier from that basis — the caller may
 * push the requirement UP by declaring a larger amount, but can never push
 * it down below what the target's real balance already demands.
 *
 * This supersedes the ceiling-binding convention (Option A) this file
 * previously tested. F needs no signing-convention change: signing the
 * floor/`minAmount` — today's dashboard behaviour — keeps landing on the
 * correct tier, because the balance, not the declared amount, floors it.
 *
 * Covered here:
 *   1. The bypass stays closed: understating `amount` against a
 *      high-balance target still requires the tier the balance demands.
 *   2. The floor convention keeps working: signing amount = 0 (today's
 *      `minAmount`) still lands on the correct tier, because balanceOf(to)
 *      floors the basis. This is F's key advantage over A — proved
 *      explicitly on Unfreeze, where the balance is provably static.
 *   3. Deliberate over-approval: declaring an amount ABOVE the balance
 *      escalates to a higher tier, and a quorum collected at that tier
 *      still executes (the documented mitigation for Freeze's griefing
 *      case — contested freezes should be signed at the top tier).
 *   4. Mint/Burn regression guard: `basis` is scoped to Freeze/Unfreeze
 *      only, so a 1M burn from a wallet holding billions must NOT escalate
 *      to a higher tier — that would be a liveness regression, not a fix.
 *   5. An empty wallet still resolves to the base tier.
 */
describe("[QTB-02] executeOperation — tier-basis remediation (Option F)", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE"));

  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  // Production tier boundaries (Kaia / Kairos / Ethereum / BNB).
  const FIVE_HUNDRED_MILLION = idrp6("500000000");
  const ONE_BILLION = idrp6("1000000000");
  const TEN_BILLION = idrp6("10000000000");

  // Sits inside [500M, 1B) → the two-role (Officer + Manager) tier.
  const TARGET_BALANCE = idrp6("700000000");

  // Sits inside [1B, 10B) → the three-role (Officer + Manager + Director) tier.
  const WHALE_BALANCE = idrp6("4000000000");

  // What a dishonest officer declares instead of the whale's real balance.
  // Alone it would select the one-role tier.
  const UNDERSTATED_AMOUNT = idrp6("1000000");

  // Deliberately escalated past TEN_BILLION, into the four-role top tier.
  const OVER_APPROVED_AMOUNT = idrp6("20000000000");

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  const freezeUnfreezeTiers = [
    { minAmount: 0n, maxAmount: FIVE_HUNDRED_MILLION, requiredRoles: [OFFICER_ROLE] },
    { minAmount: FIVE_HUNDRED_MILLION, maxAmount: ONE_BILLION, requiredRoles: [OFFICER_ROLE, MANAGER_ROLE] },
    { minAmount: ONE_BILLION, maxAmount: TEN_BILLION, requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE] },
    {
      minAmount: TEN_BILLION,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
    },
  ];

  const mintBurnTiers = [
    { minAmount: 0n, maxAmount: FIVE_HUNDRED_MILLION, requiredRoles: [OFFICER_ROLE] },
    { minAmount: FIVE_HUNDRED_MILLION, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE, MANAGER_ROLE] },
  ];

  async function deployFixture() {
    const [admin, officer, manager, director, commissioner, depository, target, whale, emptyWallet] =
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

    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await controller.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await controller.connect(admin).grantRole(DIRECTOR_ROLE, director.address);
    await controller.connect(admin).grantRole(COMMISSIONER_ROLE, commissioner.address);

    await controller.connect(admin).setQuorumRules(OperationType.Freeze, freezeUnfreezeTiers);
    await controller.connect(admin).setQuorumRules(OperationType.Unfreeze, freezeUnfreezeTiers);
    await controller.connect(admin).setQuorumRules(OperationType.Mint, mintBurnTiers);
    await controller.connect(admin).setQuorumRules(OperationType.Burn, mintBurnTiers);

    // Fund `target` (700M) and `whale` (4B) directly — bypasses
    // executeOperation so fixture setup doesn't depend on the quorum path
    // under test. `emptyWallet` is left untouched (0 balance).
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(TARGET_BALANCE);
    await idrp.connect(depository).transfer(target.address, TARGET_BALANCE);
    await idrp.connect(admin).mint(WHALE_BALANCE);
    await idrp.connect(depository).transfer(whale.address, WHALE_BALANCE);
    await idrp.connect(admin).setController(await controller.getAddress());

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

    return {
      idrp, controller, domain, types,
      admin, officer, manager, director, commissioner, depository, target, whale, emptyWallet,
    };
  }

  /** Build an operation struct with a deadline one hour out. */
  async function buildOp(
    operationType: OperationType,
    to: string,
    amount: bigint,
    operationIdentifier: string
  ) {
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    return { to, operationType, amount, operationIdentifier, deadline: now + 3600 };
  }

  /**
   * Submit an operation and report whether it landed, without letting a
   * revert fail the test outright.
   */
  async function tryExecute(controller: any, submitter: any, op: any, signatures: string[]) {
    try {
      await controller
        .connect(submitter)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, signatures);
      return { executed: true, reason: null as string | null };
    } catch (e: any) {
      return { executed: false, reason: (e?.shortMessage ?? e?.message ?? "reverted") as string };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. The bypass stays closed.
  // ─────────────────────────────────────────────────────────────────────────

  it("Freeze: a lone officer's understated amount against a high-balance target is rejected", async function () {
    const { controller, officer, domain, types, whale, idrp } = await loadFixture(deployFixture);

    // Declares 1M against a wallet actually holding 4B. Alone, 1M selects
    // the one-role tier — but basis = max(1M, 4B) = 4B, the three-role tier.
    const op = await buildOp(OperationType.Freeze, whale.address, UNDERSTATED_AMOUNT, "qtbf-bypass-freeze-lone");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, `expected a lone officer to be rejected — got: ${result.reason}`).to.equal(false);
    expect(await idrp.frozen(whale.address)).to.equal(false);
  });

  it("Freeze: the SAME understated amount succeeds once the balance's real tier quorum signs", async function () {
    const { controller, officer, manager, director, domain, types, whale, idrp } = await loadFixture(deployFixture);

    // Proves the tier is driven by the 4B balance, not by the declared 1M —
    // three signatures, exactly the roles the balance (not the amount) needs.
    const op = await buildOp(OperationType.Freeze, whale.address, UNDERSTATED_AMOUNT, "qtbf-bypass-freeze-quorum");
    const sigs = await Promise.all([officer, manager, director].map((s) => s.signTypedData(domain, types, op)));

    const result = await tryExecute(controller, officer, op, sigs);

    expect(result.executed, `expected the real-tier quorum to succeed — got: ${result.reason}`).to.equal(true);
    expect(await idrp.frozen(whale.address)).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. The floor convention keeps working — F's key advantage over A.
  // ─────────────────────────────────────────────────────────────────────────

  it("Unfreeze: signing amount = 0 (today's floor convention) still requires the balance's real tier — a lone officer is rejected", async function () {
    const { controller, officer, manager, domain, types, target, idrp } = await loadFixture(deployFixture);

    // Freeze honestly first, itself signed at the floor (amount = 0) — it
    // only works because basis floors to the 700M balance, the two-role tier.
    const freezeOp = await buildOp(OperationType.Freeze, target.address, 0n, "qtbf-floor-freeze-setup");
    const freezeSigs = await Promise.all([officer, manager].map((s) => s.signTypedData(domain, types, freezeOp)));
    await controller.connect(officer).executeOperation(
      freezeOp.operationType, freezeOp.to, freezeOp.amount, freezeOp.operationIdentifier, freezeOp.deadline, freezeSigs
    );
    expect(await idrp.frozen(target.address)).to.equal(true);

    // The balance is static post-freeze (frozen accounts can't move funds),
    // so amount = 0 must still resolve to the two-role tier — a lone
    // officer is short one role.
    const op = await buildOp(OperationType.Unfreeze, target.address, 0n, "qtbf-floor-unfreeze-lone");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, `expected a lone officer to be rejected — got: ${result.reason}`).to.equal(false);
    expect(await idrp.frozen(target.address)).to.equal(true);
  });

  it("Unfreeze: amount = 0 succeeds once the correct two-role quorum for the balance's tier signs — no dashboard change needed", async function () {
    const { controller, officer, manager, domain, types, target, idrp } = await loadFixture(deployFixture);

    const freezeOp = await buildOp(OperationType.Freeze, target.address, 0n, "qtbf-floor-freeze-setup2");
    const freezeSigs = await Promise.all([officer, manager].map((s) => s.signTypedData(domain, types, freezeOp)));
    await controller.connect(officer).executeOperation(
      freezeOp.operationType, freezeOp.to, freezeOp.amount, freezeOp.operationIdentifier, freezeOp.deadline, freezeSigs
    );

    // Same amount = 0 as the rejected lone-officer case above — only the
    // signer set changes. This is the dashboard's EXISTING behaviour (it
    // sends minAmount today) landing on the correct tier unmodified.
    const op = await buildOp(OperationType.Unfreeze, target.address, 0n, "qtbf-floor-unfreeze-quorum");
    const sigs = await Promise.all([officer, manager].map((s) => s.signTypedData(domain, types, op)));

    const result = await tryExecute(controller, officer, op, sigs);

    expect(result.executed, `expected the two-role quorum to succeed — got: ${result.reason}`).to.equal(true);
    expect(await idrp.frozen(target.address)).to.equal(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Deliberate over-approval — the griefing mitigation, now explicit in
  //    the signed data (see OPTIONS.md).
  // ─────────────────────────────────────────────────────────────────────────

  it("over-approval: declaring an amount above the balance escalates the tier, and a top-tier quorum still executes", async function () {
    const { controller, officer, manager, director, commissioner, domain, types, target, idrp } =
      await loadFixture(deployFixture);

    // Target's 700M balance alone would need only [OFFICER, MANAGER], but
    // the declared amount pushes basis to the top tier — exactly the move
    // OPTIONS.md recommends for a contested freeze.
    const op = await buildOp(OperationType.Freeze, target.address, OVER_APPROVED_AMOUNT, "qtbf-over-approve");
    const sigs = await Promise.all(
      [officer, manager, director, commissioner].map((s) => s.signTypedData(domain, types, op))
    );

    const result = await tryExecute(controller, officer, op, sigs);

    expect(result.executed, `expected the over-approved quorum to succeed — got: ${result.reason}`).to.equal(true);
    expect(await idrp.frozen(target.address)).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Mint/Burn regression guard — basis is scoped to Freeze/Unfreeze only.
  // ─────────────────────────────────────────────────────────────────────────

  it("Mint tier selection is unchanged: the declared amount alone still selects the tier", async function () {
    const { controller, idrp, officer, depository, domain, types } = await loadFixture(deployFixture);

    const before = await idrp.balanceOf(depository.address);
    const mintAmount = idrp6("1000");
    const op = await buildOp(OperationType.Mint, hre.ethers.ZeroAddress, mintAmount, "qtbf-mint-regression");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, `expected the one-role mint to land — got: ${result.reason}`).to.equal(true);
    expect(await idrp.balanceOf(depository.address)).to.equal(before + mintAmount);
  });

  it("Burn tier selection is unchanged: a 1M burn from a wallet holding billions does NOT escalate to a higher tier", async function () {
    const { controller, idrp, officer, admin, depository, domain, types } = await loadFixture(deployFixture);

    // Fund the depository with a large balance directly — if Burn picked up
    // the Freeze/Unfreeze basis logic, this alone would force the top tier
    // and turn a routine 1M burn into a liveness regression.
    const depositoryBalance = idrp6("4000000000"); // 4B
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(depositoryBalance);
    await idrp.connect(admin).setController(await controller.getAddress());

    const burnAmount = idrp6("1000000"); // 1M — well under the 500M base-tier ceiling
    const op = await buildOp(OperationType.Burn, depository.address, burnAmount, "qtbf-burn-regression");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, `expected the one-role burn to land — got: ${result.reason}`).to.equal(true);
    expect(await idrp.balanceOf(depository.address)).to.equal(depositoryBalance - burnAmount);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Edge case — an empty wallet.
  // ─────────────────────────────────────────────────────────────────────────

  it("an empty wallet still resolves to the base tier", async function () {
    const { controller, idrp, officer, emptyWallet, domain, types } = await loadFixture(deployFixture);

    expect(await idrp.balanceOf(emptyWallet.address)).to.equal(0n);

    const op = await buildOp(OperationType.Freeze, emptyWallet.address, 0n, "qtbf-empty-wallet");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, `expected the base tier to suffice for an empty wallet — got: ${result.reason}`).to.equal(true);
    expect(await idrp.frozen(emptyWallet.address)).to.equal(true);
  });
});

import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [QTB-01] IDRPController.executeOperation — quorum tier is selected by
 *          caller-supplied `amount`.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  TWO TESTS IN THIS FILE ARE EXPECTED TO FAIL.                        │
 * │  That is deliberate. They assert the security invariant we WANT,     │
 * │  not the behaviour we currently HAVE. They turn green when the       │
 * │  finding is remediated and must not be skipped, xit'd or deleted     │
 * │  before then.                                                        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * The finding (internal, 2026-08-28):
 *
 *   executeOperation picks the quorum rule straight from `amount` (L435):
 *
 *       QuorumRule memory rule = getQuorumRule(operationType, amount);
 *
 *   `amount` is unvalidated caller input, and the Controller never reads the
 *   target's balance. For Freeze/Unfreeze `amount` is not even used by the
 *   effect (L462/L464 call freeze(to) / unfreeze(to)). So it does exactly two
 *   things: select the tier, and get hashed into the EIP-712 struct.
 *
 *   A lone OFFICER_ROLE holder can therefore declare a small `amount`, land in
 *   the single-signature tier, and freeze or unfreeze a wallet whose real
 *   balance was meant to require three signers. They can submit it themselves
 *   too — the caller gate at L406-413 accepts any of the five roles.
 *
 * The invariant tests below are written to be REMEDIATION-AGNOSTIC. They assert
 * on the resulting `frozen` flag rather than on a revert string, so they pass
 * under either proposed fix:
 *
 *   Option 1 — Freeze becomes single-tier; the check applies to Unfreeze only.
 *              (Reverts with a missing-role error.)
 *   Option 2 — An execute-time `require(amount >= balanceOf(to))` on both.
 *              (Reverts with "amount below target balance".)
 *
 * The CONTROL tests pass today and must keep passing. They exist so that a
 * failure above can never be mistaken for a broken harness: they prove the
 * quorum genuinely rejects a lone officer once `amount` is truthful, and that
 * the honest three-role path genuinely works.
 */
describe("[QTB-01] executeOperation — quorum tier bypass via `amount`", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE"));

  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  // Production tier boundaries (Kaia / Kairos / Ethereum / BNB).
  const FIVE_HUNDRED_MILLION = idrp6("500000000");
  const ONE_BILLION = idrp6("1000000000");
  const TEN_BILLION = idrp6("10000000000");

  // The target wallet. 4B sits in the [1B, 10B) tier → three signers required.
  const WHALE_BALANCE = idrp6("4000000000");

  // What a dishonest officer declares instead. Lands in [0, 500M) → one signer.
  const UNDERSTATED_AMOUNT = idrp6("1000000");

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

  async function deployFixture() {
    const [admin, officer, manager, director, commissioner, depository, whale] =
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
    await controller
      .connect(admin)
      .setQuorumRules(OperationType.Mint, [
        { minAmount: 0n, maxAmount: FIVE_HUNDRED_MILLION, requiredRoles: [OFFICER_ROLE] },
        {
          minAmount: FIVE_HUNDRED_MILLION,
          maxAmount: hre.ethers.MaxUint256,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
      ]);

    // Fund the whale: mint into the depository, forward, then hand the
    // controller role over to the Controller proxy (production wiring).
    await idrp.connect(admin).setController(admin.address);
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
      admin, officer, manager, director, commissioner, depository, whale,
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
   * Submit an operation and report whether it landed, without letting a revert
   * fail the test. Lets one assertion cover both the vulnerable and the
   * remediated contract.
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
  // Preconditions — these describe the intended policy. All pass today.
  // ─────────────────────────────────────────────────────────────────────────

  it("precondition: the target's real balance sits in the three-role tier", async function () {
    const { idrp, controller, whale } = await loadFixture(deployFixture);

    expect(await idrp.balanceOf(whale.address)).to.equal(WHALE_BALANCE);

    const honest = await controller.getQuorumRule(OperationType.Freeze, WHALE_BALANCE);
    expect(honest.requiredRoles).to.deep.equal([OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE]);
  });

  it("precondition: the understated amount resolves to the one-role tier", async function () {
    const { controller } = await loadFixture(deployFixture);

    const understated = await controller.getQuorumRule(OperationType.Freeze, UNDERSTATED_AMOUNT);
    expect(understated.requiredRoles).to.deep.equal([OFFICER_ROLE]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONTROL — proves the harness is sound. Must pass before AND after the fix.
  // ─────────────────────────────────────────────────────────────────────────

  it("control: with a truthful amount, a lone officer is correctly rejected", async function () {
    const { controller, officer, domain, types, whale, idrp } = await loadFixture(deployFixture);

    // Same officer, same target — the only difference from the bypass is that
    // `amount` now tells the truth about the wallet.
    const op = await buildOp(OperationType.Freeze, whale.address, WHALE_BALANCE, "qtb-control-truthful");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, "a lone officer must not satisfy a three-role tier").to.equal(false);
    expect(await idrp.frozen(whale.address)).to.equal(false);
  });

  it("control: the honest three-role path freezes the wallet", async function () {
    const { controller, officer, manager, director, domain, types, whale, idrp } =
      await loadFixture(deployFixture);

    const op = await buildOp(OperationType.Freeze, whale.address, WHALE_BALANCE, "qtb-control-honest");
    const sigs = await Promise.all(
      [officer, manager, director].map((s) => s.signTypedData(domain, types, op))
    );

    const result = await tryExecute(controller, officer, op, sigs);

    expect(result.executed, `the honest path must work — got: ${result.reason}`).to.equal(true);
    expect(await idrp.frozen(whale.address)).to.equal(true);
  });

  it("scope: Mint is NOT affected — understating the amount understates the mint", async function () {
    const { controller, idrp, officer, depository, domain, types } = await loadFixture(deployFixture);

    // For Mint, `amount` IS the effect. Declaring a small number to reach the
    // one-role tier only ever mints that small number. Nothing is bypassed.
    const before = await idrp.balanceOf(depository.address);

    const op = await buildOp(OperationType.Mint, hre.ethers.ZeroAddress, UNDERSTATED_AMOUNT, "qtb-scope-mint");
    const officerSig = await officer.signTypedData(domain, types, op);

    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(result.executed, `expected the one-role mint to land — got: ${result.reason}`).to.equal(true);
    expect(await idrp.balanceOf(depository.address)).to.equal(before + UNDERSTATED_AMOUNT);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SECURITY INVARIANTS — EXPECTED TO FAIL until the finding is remediated.
  // ─────────────────────────────────────────────────────────────────────────

  it("INVARIANT (expected to fail today): a lone officer cannot FREEZE a wallet whose balance requires three roles", async function () {
    const { controller, idrp, officer, domain, types, whale } = await loadFixture(deployFixture);

    // The bypass: declare 1,000,000 against a wallet actually holding
    // 4,000,000,000. The declared amount lands in the one-role tier, and
    // freeze(to) ignores it entirely.
    const op = await buildOp(OperationType.Freeze, whale.address, UNDERSTATED_AMOUNT, "qtb-bypass-freeze");
    const officerSig = await officer.signTypedData(domain, types, op);

    // Signer and submitter are the same person — the caller gate accepts any
    // of the five roles.
    const result = await tryExecute(controller, officer, op, [officerSig]);

    expect(
      await idrp.frozen(whale.address),
      [
        "",
        "  BYPASS REPRODUCED — a single OFFICER_ROLE holder froze a wallet",
        `  holding ${hre.ethers.formatUnits(WHALE_BALANCE, 6)} IDRP by declaring`,
        `  amount = ${hre.ethers.formatUnits(UNDERSTATED_AMOUNT, 6)}, which selects the one-role tier.`,
        "  The policy required OFFICER + MANAGER + DIRECTOR.",
        `  executeOperation returned: ${result.executed ? "success" : result.reason}`,
        "",
        "  This test is EXPECTED TO FAIL until remediation lands. Do not skip it.",
        "",
      ].join("\n")
    ).to.equal(false);
  });

  it("INVARIANT (expected to fail today): a lone officer cannot UNFREEZE a wallet whose balance requires three roles", async function () {
    const { controller, idrp, officer, manager, director, domain, types, whale } =
      await loadFixture(deployFixture);

    // First freeze it properly, with the full three-role quorum the policy
    // demands — this is the decision the bypass gets to undo.
    const freezeOp = await buildOp(OperationType.Freeze, whale.address, WHALE_BALANCE, "qtb-setup-honest-freeze");
    const freezeSigs = await Promise.all(
      [officer, manager, director].map((s) => s.signTypedData(domain, types, freezeOp))
    );
    await controller
      .connect(officer)
      .executeOperation(
        freezeOp.operationType, freezeOp.to, freezeOp.amount,
        freezeOp.operationIdentifier, freezeOp.deadline, freezeSigs
      );
    expect(await idrp.frozen(whale.address)).to.equal(true);

    // Now one officer reverses it alone, with amount = 1 base unit.
    const unfreezeOp = await buildOp(OperationType.Unfreeze, whale.address, 1n, "qtb-bypass-unfreeze");
    const officerSig = await officer.signTypedData(domain, types, unfreezeOp);

    const result = await tryExecute(controller, officer, unfreezeOp, [officerSig]);

    expect(
      await idrp.frozen(whale.address),
      [
        "",
        "  BYPASS REPRODUCED — a single OFFICER_ROLE holder UNFROZE a wallet",
        `  holding ${hre.ethers.formatUnits(WHALE_BALANCE, 6)} IDRP by declaring amount = 1,`,
        "  reversing a freeze that had required OFFICER + MANAGER + DIRECTOR.",
        "  This is the most damaging direction: one signature undoes a",
        "  multi-role decision and returns control of the wallet to its holder.",
        `  executeOperation returned: ${result.executed ? "success" : result.reason}`,
        "",
        "  This test is EXPECTED TO FAIL until remediation lands. Do not skip it.",
        "",
      ].join("\n")
    ).to.equal(true);
  });
});

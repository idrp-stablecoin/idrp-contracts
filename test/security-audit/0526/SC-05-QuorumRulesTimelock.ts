import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [V5-4] Audit v5.0 finding SC-05 (High): setQuorumRules had no timelock — a
 * compromised ADMIN_ROLE could lower a quorum and execute a malicious op in the
 * next tx, defeating the multi-sig.
 *
 * Meeting 29-05: "[SC.05] iya tambahin aja timelock".
 *
 * audit-5.0 phase-1 (SC-05) fix:
 *   • First-time setup (op type has no rules yet) applies instantly via
 *     setQuorumRules — bootstrap/deploy path, no "lowering" risk.
 *   • CHANGING an op type that already has rules is rejected by setQuorumRules
 *     and must go through scheduleQuorumRules → wait UPGRADE_DELAY →
 *     applyQuorumRules. cancelQuorumRules aborts a pending change.
 *
 * These tests pin the lifecycle and prove the same-tx lower-then-execute bypass
 * is no longer possible.
 */
describe("[0526 SC-05] IDRPController.setQuorumRules — timelock", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("MANAGER_ROLE")
  );
  const UPGRADE_DELAY = 48 * 60 * 60;
  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6);

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  // A valid, contiguous single-rule set covering [0, max).
  function singleRule(roles: string[]) {
    return [
      { minAmount: 0, maxAmount: hre.ethers.MaxUint256, requiredRoles: roles },
    ];
  }

  async function deployFixture() {
    const [admin, officer, manager, depository, attacker] =
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

    return { idrp, controller, admin, officer, manager, depository, attacker, domain, types };
  }

  it("first-time setup applies instantly (bootstrap path)", async function () {
    const { controller } = await loadFixture(deployFixture);

    await expect(
      controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]))
    ).to.emit(controller, "QuorumRulesUpdated");

    const rule = await controller.getQuorumRule(OperationType.Mint, 1);
    expect(rule.requiredRoles).to.deep.equal([OFFICER_ROLE]);
  });

  it("changing existing rules via setQuorumRules is rejected (must schedule)", async function () {
    const { controller } = await loadFixture(deployFixture);

    await controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]));

    await expect(
      controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE, MANAGER_ROLE]))
    ).to.be.revertedWith("Rules exist: use schedule");
  });

  it("scheduled change cannot be applied before UPGRADE_DELAY", async function () {
    const { controller } = await loadFixture(deployFixture);

    await controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]));

    await expect(
      controller.scheduleQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE, MANAGER_ROLE]))
    ).to.emit(controller, "QuorumRulesScheduled");

    await expect(
      controller.applyQuorumRules(OperationType.Mint)
    ).to.be.revertedWith("Timelock not expired");

    // Even 1 second short of the delay still reverts.
    await time.increase(UPGRADE_DELAY - 5);
    await expect(
      controller.applyQuorumRules(OperationType.Mint)
    ).to.be.revertedWith("Timelock not expired");
  });

  it("getPendingQuorumRules reflects pending state and clears after apply/cancel", async function () {
    const { controller } = await loadFixture(deployFixture);

    await controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]));

    // Nothing pending yet.
    let pending = await controller.getPendingQuorumRules(OperationType.Mint);
    expect(pending.exists).to.equal(false);
    expect(pending.executableAfter).to.equal(0);
    expect(pending.rules.length).to.equal(0);

    // After scheduling, the view exposes the queued rules + executable timestamp.
    await controller.scheduleQuorumRules(
      OperationType.Mint,
      singleRule([OFFICER_ROLE, MANAGER_ROLE])
    );
    pending = await controller.getPendingQuorumRules(OperationType.Mint);
    expect(pending.exists).to.equal(true);
    expect(pending.executableAfter).to.be.gt(0);
    expect(pending.rules.length).to.equal(1);
    expect(pending.rules[0].requiredRoles).to.deep.equal([OFFICER_ROLE, MANAGER_ROLE]);

    // After apply, the view is cleared.
    await time.increase(UPGRADE_DELAY + 1);
    await controller.applyQuorumRules(OperationType.Mint);
    pending = await controller.getPendingQuorumRules(OperationType.Mint);
    expect(pending.exists).to.equal(false);
  });

  it("scheduled change applies after UPGRADE_DELAY and replaces the live rules", async function () {
    const { controller } = await loadFixture(deployFixture);

    await controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]));
    await controller.scheduleQuorumRules(
      OperationType.Mint,
      singleRule([OFFICER_ROLE, MANAGER_ROLE])
    );

    await time.increase(UPGRADE_DELAY + 1);
    await expect(
      controller.applyQuorumRules(OperationType.Mint)
    ).to.emit(controller, "QuorumRulesUpdated");

    const rule = await controller.getQuorumRule(OperationType.Mint, 1);
    expect(rule.requiredRoles).to.deep.equal([OFFICER_ROLE, MANAGER_ROLE]);

    // Pending state cleared; a second apply reverts.
    await expect(
      controller.applyQuorumRules(OperationType.Mint)
    ).to.be.revertedWith("No pending quorum rules");
  });

  it("cancelQuorumRules aborts a pending change", async function () {
    const { controller } = await loadFixture(deployFixture);

    await controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]));
    await controller.scheduleQuorumRules(
      OperationType.Mint,
      singleRule([OFFICER_ROLE, MANAGER_ROLE])
    );

    await expect(
      controller.cancelQuorumRules(OperationType.Mint)
    ).to.emit(controller, "QuorumRulesCancelled");

    await time.increase(UPGRADE_DELAY + 1);
    // Nothing to apply after cancel.
    await expect(
      controller.applyQuorumRules(OperationType.Mint)
    ).to.be.revertedWith("No pending quorum rules");

    // Live rules unchanged (still officer-only).
    const rule = await controller.getQuorumRule(OperationType.Mint, 1);
    expect(rule.requiredRoles).to.deep.equal([OFFICER_ROLE]);
  });

  it("ATTACK BLOCKED: cannot lower a quorum and execute in the same window", async function () {
    const { controller, idrp, officer, depository, domain, types } =
      await loadFixture(deployFixture);

    // Live rule: mint needs officer + manager (two-of).
    await controller.setQuorumRules(
      OperationType.Mint,
      singleRule([OFFICER_ROLE, MANAGER_ROLE])
    );

    // Attacker-admin schedules a weakened rule (officer-only) but CANNOT apply
    // it yet — so an immediate single-sig mint still fails the live two-of rule.
    await controller.scheduleQuorumRules(
      OperationType.Mint,
      singleRule([OFFICER_ROLE])
    );

    const latest = await hre.ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + 3600;
    const op = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: ONE_HUNDRED_MILLION,
      operationIdentifier: "attack-1",
      deadline,
    };
    const officerSig = await officer.signTypedData(domain, types, op);

    // Single officer signature against the STILL-LIVE two-of rule → reverts.
    let reverted = false;
    try {
      await controller
        .connect(officer)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, [officerSig]);
    } catch {
      reverted = true;
    }
    expect(reverted).to.equal(true);

    // No mint happened.
    expect(await idrp.balanceOf(depository.address)).to.equal(0);
  });

  it("rule validation still runs on both setQuorumRules and scheduleQuorumRules", async function () {
    const { controller } = await loadFixture(deployFixture);

    // Bad first-time set (doesn't end at max) → rejected.
    await expect(
      controller.setQuorumRules(OperationType.Mint, [
        { minAmount: 0, maxAmount: ONE_HUNDRED_MILLION, requiredRoles: [OFFICER_ROLE] },
      ])
    ).to.be.revertedWith("Last rule must cover max amount");

    // Valid first-time set, then a bad scheduled change → rejected.
    await controller.setQuorumRules(OperationType.Mint, singleRule([OFFICER_ROLE]));
    await expect(
      controller.scheduleQuorumRules(OperationType.Mint, [])
    ).to.be.revertedWith("Rules cannot be empty");
  });
});

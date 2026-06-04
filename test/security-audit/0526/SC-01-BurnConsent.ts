import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [0526 SC-01] IDRP.burn — controller-or-depository invariant.
 *
 * 052026 audit SC-01 (Critical) raised: MINTER_ROLE force-burning a user's
 * balance without consent. The 052026 fix landed an allowance-gated consent
 * path. The 062026 controller-only update tightened it further:
 *
 *   IDRP.burn(from, amount) now authorizes EXACTLY TWO sources:
 *     1. from == _msgSender()  → the controller burns its OWN balance.
 *     2. from == depository    → the protocol cold wallet (cannot approve).
 *
 *   Any other `from` reverts unconditionally — there is no allowance path
 *   anymore. The offramp pattern is "user transfers to controller, controller
 *   self-burns" (exercised by IDRPController.TransferApproachBurnTests.ts).
 *
 * These tests pin: third-party burns ALWAYS revert (with or without
 * allowance), self-burn and depository-burn still work, frozen takes
 * precedence over both.
 */
describe("[0526 SC-01] IDRP.burn — controller-or-depository invariant", function () {
  const ONE_HUNDRED = hre.ethers.parseUnits("100", 6);

  async function deployFixture() {
    const [admin, depository, minter, victim, attackerSink] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    // v3 collapses MINTER_ROLE → single `controller`. For SC-01 we exercise
    // burn against `minter` as the controller. Temporarily flip controller to
    // `admin` for setup (mint pool + seed victim), then hand it to `minter`.
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).mint(ONE_HUNDRED * 100n);
    await idrp.connect(depository).transfer(victim.address, ONE_HUNDRED * 10n);

    await idrp.connect(admin).setController(minter.address);

    return { idrp, admin, depository, minter, victim, attackerSink };
  }

  it("CRITICAL path blocked: controller burning a third party reverts", async function () {
    const { idrp, minter, victim } = await loadFixture(deployFixture);

    // The exact SC-01 attack: the controller tries to destroy the victim's
    // balance. Under the tightened invariant this reverts even when the
    // controller is a fully-trusted signer.
    await expect(
      idrp.connect(minter).burn(victim.address, ONE_HUNDRED)
    ).to.be.revertedWith("Only controller or depository wallet can burn tokens");

    // Victim's balance is untouched.
    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 10n);
  });

  it("allowance does NOT unlock a third-party burn anymore (path removed in 062026)", async function () {
    const { idrp, minter, victim } = await loadFixture(deployFixture);

    // Pre-062026 this would have been the "consent" path; now even a fully
    // approved allowance does not allow burning a third party.
    await idrp.connect(victim).approve(minter.address, ONE_HUNDRED);

    await expect(
      idrp.connect(minter).burn(victim.address, ONE_HUNDRED)
    ).to.be.revertedWith("Only controller or depository wallet can burn tokens");

    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 10n);
    // Allowance is untouched — the call reverted before any state change.
    expect(await idrp.allowance(victim.address, minter.address)).to.equal(
      ONE_HUNDRED
    );
  });

  it("self-burn path works: the controller burning its OWN balance succeeds", async function () {
    const { idrp, depository, minter } = await loadFixture(deployFixture);

    // Give the controller (minter) its own tokens (simulating tokens
    // transferred to the controller in the transfer-approach offramp), then
    // it self-burns.
    await idrp.connect(depository).transfer(minter.address, ONE_HUNDRED);
    expect(await idrp.balanceOf(minter.address)).to.equal(ONE_HUNDRED);

    await idrp.connect(minter).burn(minter.address, ONE_HUNDRED);
    expect(await idrp.balanceOf(minter.address)).to.equal(0);
  });

  it("depository path works: burning the depository cold wallet succeeds", async function () {
    const { idrp, minter, depository } = await loadFixture(deployFixture);

    const before = await idrp.balanceOf(depository.address);
    await idrp.connect(minter).burn(depository.address, ONE_HUNDRED);
    expect(await idrp.balanceOf(depository.address)).to.equal(
      before - ONE_HUNDRED
    );
  });

  it("controller cannot reach an arbitrary third party EVEN with mint-to-attackerSink-style indirection", async function () {
    const { idrp, minter, victim, attackerSink } = await loadFixture(deployFixture);

    // The only `from` values that work are the controller's own address and
    // the depositoryWallet. Any other address — including a freshly-created
    // sink — reverts.
    await expect(
      idrp.connect(minter).burn(attackerSink.address, 1n)
    ).to.be.revertedWith("Only controller or depository wallet can burn tokens");

    await expect(
      idrp.connect(minter).burn(victim.address, 1n)
    ).to.be.revertedWith("Only controller or depository wallet can burn tokens");

    // Both balances untouched.
    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 10n);
    expect(await idrp.balanceOf(attackerSink.address)).to.equal(0n);
  });

  it("frozen takes precedence: the freeze check runs BEFORE the from-must-be-controller-or-depository check", async function () {
    const { idrp, minter, depository } = await loadFixture(deployFixture);

    // Freeze the depository wallet — even though it's a legitimate burn
    // target, the frozen check should fire first.
    await idrp.connect(minter).freeze(depository.address);

    await expect(
      idrp.connect(minter).burn(depository.address, ONE_HUNDRED)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("frozen also fires on a third-party burn attempt (defense in depth)", async function () {
    const { idrp, minter, victim } = await loadFixture(deployFixture);

    await idrp.connect(minter).freeze(victim.address);

    // The error here is FrozenAccount, not the controller/depository revert —
    // the frozen check runs first. This is the SAME outcome (revert) but the
    // specific custom error is what we assert so a future reordering of the
    // checks is caught by this test.
    await expect(
      idrp.connect(minter).burn(victim.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });
});

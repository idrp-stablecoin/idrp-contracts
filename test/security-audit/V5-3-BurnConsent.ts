import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [V5-3] Audit v5.0 finding SC-01 (Critical): MINTER_ROLE force-burning any
 * user's tokens without consent.
 *
 * Meeting 29-05: "[SC.01] burn only on controller, `from` dihapus" — discussed,
 * then revised: the live offramp burns from the USER's wallet after they
 * approve() the controller, so `from` must stay. The real invariant we want is
 * the audit's: a MINTER cannot destroy a THIRD PARTY's balance without that
 * party's consent.
 *
 * Current IDRP.burn(from, amount) authorizes exactly three sources:
 *   1. from == msg.sender   → caller burns its OWN balance (transfer-approach
 *                             offramp: user transfers to controller, controller
 *                             self-burns). Not a third party.
 *   2. from == depository   → protocol cold wallet, can't approve (intentional).
 *   3. any other from       → REQUIRES from's allowance to the caller (consent),
 *                             decremented per burn.
 *
 * audit-5.0 phase-1 (SC-01) makes that consent invariant explicit + tested.
 * These tests pin: the dangerous no-allowance third-party burn REVERTS, while
 * the three legitimate paths work.
 */
describe("[V5-3] IDRP.burn — consent invariant (SC-01)", function () {
  const ONE_HUNDRED = hre.ethers.parseUnits("100", 6);

  async function deployFixture() {
    const [admin, depository, minter, victim, attackerSink] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    const MINTER_ROLE = await idrp.MINTER_ROLE();
    const FREEZER_ROLE = await idrp.FREEZER_ROLE();
    await idrp.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await idrp.connect(admin).grantRole(MINTER_ROLE, minter.address);
    await idrp.connect(admin).grantRole(FREEZER_ROLE, admin.address);

    await idrp.connect(admin).setDepositoryWallet(depository.address);
    // Mint a pool, then fund the victim with real tokens.
    await idrp.connect(admin).mint(ONE_HUNDRED * 100n);
    await idrp.connect(depository).transfer(victim.address, ONE_HUNDRED * 10n);

    return { idrp, admin, depository, minter, victim, attackerSink };
  }

  it("CRITICAL path blocked: MINTER force-burning a third party WITHOUT allowance reverts", async function () {
    const { idrp, minter, victim } = await loadFixture(deployFixture);

    // The exact SC-01 attack: a MINTER tries to destroy the victim's balance.
    await expect(
      idrp.connect(minter).burn(victim.address, ONE_HUNDRED)
    ).to.be.revertedWith("Burn amount exceeds allowance");

    // Victim's balance is untouched.
    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 10n);
  });

  it("consent path works: third-party burn succeeds with allowance and decrements it", async function () {
    const { idrp, minter, victim } = await loadFixture(deployFixture);

    // Victim consents by approving the minter for a bounded amount.
    await idrp.connect(victim).approve(minter.address, ONE_HUNDRED);

    await idrp.connect(minter).burn(victim.address, ONE_HUNDRED);

    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 9n);
    // Allowance fully consumed.
    expect(await idrp.allowance(victim.address, minter.address)).to.equal(0);
  });

  it("consent is bounded: burning MORE than the approved allowance reverts", async function () {
    const { idrp, minter, victim } = await loadFixture(deployFixture);

    await idrp.connect(victim).approve(minter.address, ONE_HUNDRED);

    await expect(
      idrp.connect(minter).burn(victim.address, ONE_HUNDRED * 2n)
    ).to.be.revertedWith("Burn amount exceeds allowance");

    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 10n);
  });

  it("self-burn path works: a MINTER burning its OWN balance needs no allowance", async function () {
    const { idrp, admin, depository, minter } = await loadFixture(deployFixture);

    // Give the minter its own tokens (simulating tokens transferred to the
    // controller in the transfer-approach offramp), then it self-burns.
    await idrp.connect(depository).transfer(minter.address, ONE_HUNDRED);
    expect(await idrp.balanceOf(minter.address)).to.equal(ONE_HUNDRED);

    await idrp.connect(minter).burn(minter.address, ONE_HUNDRED);
    expect(await idrp.balanceOf(minter.address)).to.equal(0);
  });

  it("depository path works: burning the depository cold wallet needs no allowance", async function () {
    const { idrp, admin, depository } = await loadFixture(deployFixture);

    const before = await idrp.balanceOf(depository.address);
    await idrp.connect(admin).burn(depository.address, ONE_HUNDRED);
    expect(await idrp.balanceOf(depository.address)).to.equal(before - ONE_HUNDRED);
  });

  it("self-burn does NOT let a MINTER reach a third party: allowance is still required for others", async function () {
    const { idrp, minter, victim, attackerSink } = await loadFixture(deployFixture);

    // Even though the minter can self-burn freely, it cannot use that to touch
    // the victim — the third-party branch still demands the victim's allowance.
    await expect(
      idrp.connect(minter).burn(victim.address, 1n)
    ).to.be.revertedWith("Burn amount exceeds allowance");

    // And it certainly cannot mint-to-attackerSink-then-burn-victim; victim is safe.
    expect(await idrp.balanceOf(victim.address)).to.equal(ONE_HUNDRED * 10n);
  });

  it("frozen third party cannot be burned even with an allowance (freeze takes precedence)", async function () {
    const { idrp, admin, minter, victim } = await loadFixture(deployFixture);

    await idrp.connect(victim).approve(minter.address, ONE_HUNDRED);
    await idrp.connect(admin).freeze(victim.address);

    await expect(
      idrp.connect(minter).burn(victim.address, ONE_HUNDRED)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });
});

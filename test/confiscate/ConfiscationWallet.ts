import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * The confiscation destination is governed by a 48h timelock.
 *
 * Why a timelock here and not on the seizure itself: the freeze precondition has
 * already immobilized the funds, so delaying the seizure protects nothing that is
 * still moving. What IS unprotected is that the same `admin` both chooses the
 * destination and executes the transfer — with no quorum step, nothing else binds
 * where the money lands. The delay on the setter is that missing second control.
 *
 * Note this deliberately differs from IDRPController.setQuorumRules, where the
 * FIRST set applies instantly and only changes are timelocked. Confiscation has
 * no bootstrap urgency — `confiscate` simply reverts until a destination exists —
 * so there is one code path, always delayed.
 */
describe("Confiscate — confiscationWallet timelock", function () {
  const FORTY_EIGHT_HOURS = 48 * 60 * 60;

  async function deployFixture() {
    const [admin, depository, seizedFunds, other, alice] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    return { idrp, admin, depository, seizedFunds, other, alice };
  }

  it("schedules a change and emits the executable-after timestamp", async function () {
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    const tx = await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    const block = await hre.ethers.provider.getBlock(tx.blockNumber!);
    await expect(tx)
      .to.emit(idrp, "ConfiscationWalletScheduled")
      .withArgs(seizedFunds.address, block!.timestamp + FORTY_EIGHT_HOURS);
    expect(await idrp.pendingConfiscationWallet()).to.equal(seizedFunds.address);
    expect(await idrp.confiscationWallet()).to.equal(hre.ethers.ZeroAddress);
  });

  it("refuses to apply before the timelock expires", async function () {
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await time.increase(FORTY_EIGHT_HOURS - 60);
    await expect(idrp.connect(admin).applyConfiscationWallet()).to.be.revertedWith(
      "Timelock not expired"
    );
    expect(await idrp.confiscationWallet()).to.equal(hre.ethers.ZeroAddress);
  });

  it("applies after the timelock and clears the pending state", async function () {
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await time.increase(FORTY_EIGHT_HOURS);
    await expect(idrp.connect(admin).applyConfiscationWallet())
      .to.emit(idrp, "ConfiscationWalletUpdated")
      .withArgs(hre.ethers.ZeroAddress, seizedFunds.address);
    expect(await idrp.confiscationWallet()).to.equal(seizedFunds.address);
    expect(await idrp.pendingConfiscationWallet()).to.equal(hre.ethers.ZeroAddress);
    expect(await idrp.confiscationWalletScheduledAt()).to.equal(0n);
  });

  it("cancels a pending change", async function () {
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await expect(idrp.connect(admin).cancelConfiscationWallet())
      .to.emit(idrp, "ConfiscationWalletCancelled")
      .withArgs(seizedFunds.address, admin.address);
    expect(await idrp.pendingConfiscationWallet()).to.equal(hre.ethers.ZeroAddress);
    expect(await idrp.confiscationWalletScheduledAt()).to.equal(0n);
    await time.increase(FORTY_EIGHT_HOURS);
    await expect(idrp.connect(admin).applyConfiscationWallet()).to.be.revertedWith(
      "No pending confiscation wallet"
    );
  });

  it("rejects non-admin callers on all three entry points", async function () {
    const { idrp, admin, seizedFunds, other } = await loadFixture(deployFixture);
    await expect(
      idrp.connect(other).scheduleConfiscationWallet(seizedFunds.address)
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await expect(
      idrp.connect(other).cancelConfiscationWallet()
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
    await time.increase(FORTY_EIGHT_HOURS);
    await expect(
      idrp.connect(other).applyConfiscationWallet()
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
  });

  it("rejects the wired controller on all three entry points — the two-party split is the whole point", async function () {
    // confiscate() itself is now authorised by the Controller's quorum (see
    // test/confiscate/Confiscate.ts), so this pins down the OTHER half of the
    // design: the controller must have zero say over WHERE seized funds go.
    // Only admin (+48h timelock) does — a wired controller is rejected here
    // exactly like any other non-admin caller.
    const { idrp, admin, seizedFunds, other } = await loadFixture(deployFixture);
    await idrp.connect(admin).setController(other.address);

    await expect(
      idrp.connect(other).scheduleConfiscationWallet(seizedFunds.address)
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");

    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await expect(
      idrp.connect(other).cancelConfiscationWallet()
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");

    await time.increase(FORTY_EIGHT_HOURS);
    await expect(
      idrp.connect(other).applyConfiscationWallet()
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
  });

  it("rejects the zero address and a no-op re-set", async function () {
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    await expect(
      idrp.connect(admin).scheduleConfiscationWallet(hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid wallet address");

    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await time.increase(FORTY_EIGHT_HOURS);
    await idrp.connect(admin).applyConfiscationWallet();

    await expect(
      idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address)
    ).to.be.revertedWith("Same wallet");
  });

  it("refuses to make the depository the confiscation wallet", async function () {
    const { idrp, admin, depository } = await loadFixture(deployFixture);
    await expect(
      idrp.connect(admin).scheduleConfiscationWallet(depository.address)
    ).to.be.revertedWith("Cannot be depository wallet");
  });

  it("refuses to make the token contract itself the confiscation wallet", async function () {
    // Seized funds landing on the token contract would be permanently
    // unrecoverable: withdrawToken explicitly refuses token == address(this).
    const { idrp, admin } = await loadFixture(deployFixture);
    const idrpAddress = await idrp.getAddress();
    await expect(
      idrp.connect(admin).scheduleConfiscationWallet(idrpAddress)
    ).to.be.revertedWith("Cannot be the token contract");
  });

  it("re-checks the depository at APPLY time, not just at schedule time", async function () {
    // The 48h window is long enough for the depository to be moved onto the
    // pending confiscation address, which would silently merge reserves with
    // seized funds. Checking only at schedule time would miss it.
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await idrp.connect(admin).setDepositoryWallet(seizedFunds.address);
    await time.increase(FORTY_EIGHT_HOURS);
    await expect(idrp.connect(admin).applyConfiscationWallet()).to.be.revertedWith(
      "Cannot be depository wallet"
    );
  });

  it("refuses to make the confiscation wallet the depository", async function () {
    const { idrp, admin, seizedFunds } = await loadFixture(deployFixture);
    await idrp.connect(admin).scheduleConfiscationWallet(seizedFunds.address);
    await time.increase(FORTY_EIGHT_HOURS);
    await idrp.connect(admin).applyConfiscationWallet();
    await expect(
      idrp.connect(admin).setDepositoryWallet(seizedFunds.address)
    ).to.be.revertedWith("Cannot be confiscation wallet");
  });
});

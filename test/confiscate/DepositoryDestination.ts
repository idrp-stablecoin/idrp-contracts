import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * The seizure destination is `depositoryWallet`. There is no separate
 * confiscation wallet and no destination timelock — both were removed.
 *
 * This file is what replaced the old destination-timelock suite, and it exists
 * to pin the consequences of that removal rather than let them live only in a
 * commit message:
 *
 *  - The retired entry points are GONE from the ABI and unreachable on-chain,
 *    not merely unused. A selector that still dispatched would be a live
 *    admin-only write into slots the contract no longer validates.
 *  - `setDepositoryWallet` inherited the `address(this)` guard from the retired
 *    destination setter. Losing it would let admin point seizures — and mints —
 *    at the token itself, where `withdrawToken` refuses to recover them.
 *  - Where seized funds land is now admin's instant call. That is the security
 *    cost of the change, and it is asserted here so nobody rediscovers it by
 *    accident.
 */
describe("Confiscate — the depository IS the destination", function () {
  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  async function deployFixture() {
    const [admin, depository, other, badActor] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    return { idrp, admin, depository, other, badActor };
  }

  // ───────────────────────────────────────────────────────────────────────
  // The retired surface is gone, in the ABI and on-chain.
  // ───────────────────────────────────────────────────────────────────────

  const RETIRED = [
    "scheduleConfiscationWallet(address)",
    "applyConfiscationWallet()",
    "cancelConfiscationWallet()",
    "confiscationWallet()",
    "pendingConfiscationWallet()",
    "confiscationWalletScheduledAt()",
  ];

  it("no longer declares any of the retired confiscation-wallet functions", async function () {
    const { idrp } = await loadFixture(deployFixture);
    const declared = idrp.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => (f as any).format("sighash"));
    for (const sig of RETIRED) {
      expect(declared, `${sig} is still in the ABI`).to.not.include(sig);
    }
  });

  it("reverts on the retired selectors instead of silently dispatching", async function () {
    // The ABI check above only proves this build forgot them. This proves a
    // deployed proxy actually rejects the old calldata: IDRP has no fallback,
    // so an unknown selector must revert rather than hit some other function.
    const { idrp, admin } = await loadFixture(deployFixture);
    const to = await idrp.getAddress();
    for (const sig of RETIRED) {
      const selector = hre.ethers.id(sig).slice(0, 10);
      // Pad with a word so the address-taking variant is well-formed too.
      const data = selector + "0".repeat(64);
      await expect(admin.call({ to, data }), `${sig} still dispatches`).to.be.reverted;
    }
  });

  it("keeps the bypass flag unexposed after the slot it shares was retired", async function () {
    const { idrp } = await loadFixture(deployFixture);
    const declared = idrp.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => (f as any).name);
    expect(declared).to.not.include("_inConfiscation");
    expect(declared).to.not.include("__deprecated_confiscationWallet");
  });

  // ───────────────────────────────────────────────────────────────────────
  // setDepositoryWallet now also chooses the seizure destination.
  // ───────────────────────────────────────────────────────────────────────

  it("refuses to make the token contract itself the depository", async function () {
    // Inherited from the retired scheduleConfiscationWallet. Without it, admin
    // could send every future mint AND every future seizure to an address
    // withdrawToken() explicitly refuses to recover from.
    const { idrp, admin } = await loadFixture(deployFixture);
    await expect(
      idrp.connect(admin).setDepositoryWallet(await idrp.getAddress())
    ).to.be.revertedWith("Cannot be the token contract");
  });

  it("rejects the zero address and a no-op re-set", async function () {
    const { idrp, admin, depository } = await loadFixture(deployFixture);
    await expect(
      idrp.connect(admin).setDepositoryWallet(hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid wallet address");
    await expect(
      idrp.connect(admin).setDepositoryWallet(depository.address)
    ).to.be.revertedWith("Same wallet");
  });

  it("is admin-only — the controller cannot move the destination", async function () {
    // The quorum authorises seizures; it must not also be able to redirect
    // their proceeds. That half of the two-party split survived the removal.
    const { idrp, admin, other, badActor } = await loadFixture(deployFixture);
    await idrp.connect(admin).setController(other.address);
    await expect(
      idrp.connect(other).setDepositoryWallet(badActor.address)
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
    await expect(
      idrp.connect(badActor).setDepositoryWallet(badActor.address)
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
  });

  it("moves the destination instantly, with no timelock", async function () {
    // Asserted as a property, not lamented as a comment: admin changes where
    // the next seizure lands within a single transaction. If a destination
    // timelock is ever reintroduced, this test is what will fail and force the
    // decision to be made explicitly.
    const { idrp, admin, other } = await loadFixture(deployFixture);
    await idrp.connect(admin).setDepositoryWallet(other.address);
    expect(await idrp.depositoryWallet()).to.equal(other.address);
  });

  it("sends a seizure to whatever the depository is at call time", async function () {
    const { idrp, admin, depository, other, badActor } = await loadFixture(deployFixture);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000"));
    await idrp.connect(depository).transfer(badActor.address, idrp6("1000"));
    await idrp.connect(admin).freeze(badActor.address);

    await idrp.connect(admin).setDepositoryWallet(other.address);
    await expect(idrp.connect(admin).confiscate(badActor.address, idrp6("1000")))
      .to.emit(idrp, "AssetsConfiscated")
      .withArgs(badActor.address, other.address, idrp6("1000"));

    expect(await idrp.balanceOf(other.address)).to.equal(idrp6("1000"));
    expect(await idrp.balanceOf(depository.address)).to.equal(0n);
  });
});

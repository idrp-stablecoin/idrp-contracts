import hre from "hardhat";
import { expect } from "chai";

/**
 * Upgrade safety for the six live proxies (Ethereum, Polygon, BNB, Kaia,
 * Kairos, Tron), for the change that removed the standalone confiscation
 * wallet and pointed `confiscate` at `depositoryWallet`.
 *
 * Kairos is the only chain that ever populated the retired slots, so it is the
 * only one whose upgrade is not a zero-to-zero no-op. The second test below
 * rehearses exactly that: dirty reserved slots, then upgrade, then check the
 * gate still holds.
 *
 * NOTE ON AUTHORITY: confiscate is gated by the Controller's EIP-712 quorum
 * (OperationType.Confiscate), not by admin. These tests wire admin directly as
 * the controller to exercise token-level behaviour; the quorum itself is
 * covered in Confiscate.ts.
 */
describe("Confiscate — upgrade safety", function () {
  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  /** Slot 9 as the Kairos proxy holds it: the retired destination address. */
  const KAIROS_SLOT_9 =
    "0x000000000000000000000000f1c508ce6b951475f204ae2d68527c6cf995c3cb";

  /** Deploys, schedules and executes a self-upgrade through the 48h timelock. */
  async function upgradeThroughTimelock(idrp: any, admin: any, IDRPFactory: any) {
    const proxyAddress = await idrp.getAddress();
    // IDRP enforces its own 48h scheduleUpgrade timelock (UPGRADE_DELAY), so
    // deploy the impl first to learn its address, schedule that exact address,
    // then let upgradeProxy reuse it — OZ caches implementations by bytecode
    // hash, so this does not deploy twice.
    const newImpl = await hre.upgrades.prepareUpgrade(proxyAddress, IDRPFactory, {
      kind: "uups",
    });
    await idrp.connect(admin).scheduleUpgrade(newImpl as string);
    await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");
    const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, IDRPFactory, {
      kind: "uups",
      unsafeSkipStorageCheck: false,
    });
    await upgraded.waitForDeployment();
    return upgraded;
  }

  it("upgrades a live proxy without a layout conflict, preserving state", async function () {
    const [admin, depository] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");

    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000"));

    const supplyBefore = await idrp.totalSupply();
    const upgraded = await upgradeThroughTimelock(idrp, admin, IDRPFactory);

    expect(await upgraded.admin()).to.equal(admin.address);
    expect(await upgraded.depositoryWallet()).to.equal(depository.address);
    expect(await upgraded.totalSupply()).to.equal(supplyBefore);
  });

  it("upgrades a proxy whose retired slots are DIRTY, without unsealing the freeze gate", async function () {
    // The Kairos case. That chain applied a confiscation wallet under the old
    // design, so slot 9 holds an address whose low byte is 0xcb. This rehearses
    // the real upgrade: dirty the reserved slots first, upgrade, then prove the
    // freeze gate still reverts. If the retired variables had been deleted
    // rather than reserved, `_inConfiscation` would sit at byte 0, read 0xcb as
    // true, and this transfer would succeed.
    const [admin, depository, alice, bob] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");

    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    const proxyAddress = await idrp.getAddress();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000"));
    await idrp.connect(depository).transfer(alice.address, idrp6("1000"));

    // Simulate the pre-upgrade state of a chain that used the old feature.
    await hre.network.provider.send("hardhat_setStorageAt", [
      proxyAddress,
      "0x9",
      KAIROS_SLOT_9,
    ]);
    await hre.network.provider.send("hardhat_setStorageAt", [
      proxyAddress,
      "0xa",
      "0x000000000000000000000000000000000000000000000000000000000000dead",
    ]);
    await hre.network.provider.send("hardhat_setStorageAt", [
      proxyAddress,
      "0xb",
      "0x0000000000000000000000000000000000000000000000000000000067000000",
    ]);

    const upgraded = await upgradeThroughTimelock(idrp, admin, IDRPFactory);

    await upgraded.connect(admin).freeze(alice.address);
    await expect(
      upgraded.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(upgraded, "FrozenAccount");

    // And a seizure still works, landing in the depository.
    await upgraded.connect(admin).confiscate(alice.address, idrp6("1000"));
    expect(await upgraded.balanceOf(depository.address)).to.equal(idrp6("1000"));
    expect(await upgraded.balanceOf(alice.address)).to.equal(0n);

    // Gate re-sealed after the seizure, with the dirty slot still dirty.
    expect(
      await hre.ethers.provider.getStorage(proxyAddress, 9)
    ).to.equal(KAIROS_SLOT_9);
    await expect(
      upgraded.connect(alice).transfer(bob.address, 1n)
    ).to.be.revertedWithCustomError(upgraded, "FrozenAccount");
  });

  it("makes confiscate live at the token level the moment the upgrade lands", async function () {
    // BEHAVIOUR CHANGE, pinned deliberately. Under the old design the token was
    // the second gate: confiscate reverted ConfiscationWalletNotSet until an
    // operator scheduled a destination and waited out 48h. That gate is gone —
    // every live chain already has a depositoryWallet, so the token-level path
    // is open as soon as the implementation lands.
    //
    // The remaining opt-in is Controller-side: executeOperation reverts with
    // "No matching quorum rule found" until setQuorumRules seeds
    // OperationType.Confiscate. That is admin-gated and INSTANT, not timelocked.
    // Seeding those rules is now the single act that arms seizure on a chain.
    const [admin, depository, badActor] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000"));
    await idrp.connect(depository).transfer(badActor.address, idrp6("1000"));
    await idrp.connect(admin).freeze(badActor.address);

    await expect(idrp.connect(admin).confiscate(badActor.address, idrp6("1000")))
      .to.emit(idrp, "AssetsConfiscated")
      .withArgs(badActor.address, depository.address, idrp6("1000"));
  });
});

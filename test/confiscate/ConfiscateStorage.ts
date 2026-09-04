import fs from "fs";
import path from "path";
import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Storage layout for the confiscation feature, after the destination wallet and
 * its timelock were removed in favour of `depositoryWallet`.
 *
 * WHY THIS FILE IS LOAD-BEARING
 *
 * `confiscationWallet` (address) and `_inConfiscation` (bool) were PACKED into
 * one slot: address at bytes 0-19, flag at byte 20. Deleting the address would
 * slide the flag down to byte 0 of that same slot — and that slot is not empty
 * on a live chain. Kairos (chainId 1001) holds
 *
 *     slot 9 = 0x…f1c508ce6b951475f204ae2d68527c6cf995c3cb
 *
 * whose low byte is 0xcb. The flag would read 0xcb as `true`, permanently, and
 * `_update`'s `if (!_inConfiscation) revert FrozenAccount();` would stop
 * reverting: every frozen account on that chain could transfer freely, and
 * every test in this repo would still pass.
 *
 * So the retired variables are RESERVED, not deleted, and the tests below
 * assert that against the real deployed bytes rather than against a story.
 */
describe("Confiscate — storage layout after the destination wallet was removed", function () {
  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  /** Slot 9 exactly as it reads on the Kairos proxy today. */
  const KAIROS_SLOT_9 =
    "0x000000000000000000000000f1c508ce6b951475f204ae2d68527c6cf995c3cb";
  /**
   * The same word with byte 20 set to 0x01 — the flag genuinely on. Counting
   * from the low end: bytes 0-19 are the address, byte 20 is the flag, bytes
   * 21-31 are zero.
   */
  const KAIROS_SLOT_9_FLAG_SET =
    "0x000000000000000000000001f1c508ce6b951475f204ae2d68527c6cf995c3cb";

  async function deployFixture() {
    const [admin, depository, alice, bob] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    return { idrp, IDRPFactory, admin, depository, alice, bob };
  }

  /** A funded, frozen alice — the shape the bypass tests need. */
  async function frozenFixture() {
    const ctx = await loadFixture(deployFixture);
    await ctx.idrp.connect(ctx.admin).setController(ctx.admin.address);
    await ctx.idrp.connect(ctx.admin).mint(idrp6("1000"));
    await ctx.idrp.connect(ctx.depository).transfer(ctx.alice.address, idrp6("1000"));
    await ctx.idrp.connect(ctx.admin).freeze(ctx.alice.address);
    return ctx;
  }

  /** The compiler's own layout — the source of truth, not a hand count. */
  function compiledLayout() {
    const dbgPath = path.join(
      hre.config.paths.artifacts,
      "contracts/IDRP.sol/IDRP.dbg.json"
    );
    const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
    const bi = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(dbgPath), dbg.buildInfo), "utf8")
    );
    return bi.output.contracts["contracts/IDRP.sol"]["IDRP"].storageLayout;
  }

  // ───────────────────────────────────────────────────────────────────────
  // The layout itself.
  // ───────────────────────────────────────────────────────────────────────

  it("keeps _inConfiscation at slot 9, byte 20 — the position the live chains assume", async function () {
    const layout = compiledLayout();
    const flag = layout.storage.find((v: any) => v.label === "_inConfiscation");
    expect(flag, "_inConfiscation is gone from storage entirely").to.not.equal(undefined);
    expect(flag.slot).to.equal("9");
    expect(flag.offset).to.equal(20);
  });

  it("reserves the three retired slots rather than deleting them", async function () {
    const layout = compiledLayout();
    const at = (slot: string, offset: number) =>
      layout.storage.find((v: any) => v.slot === slot && v.offset === offset);

    // Same slot, same offset, same width as the variables they replaced.
    expect(at("9", 0).label).to.equal("__deprecated_confiscationWallet");
    expect(layout.types[at("9", 0).type].numberOfBytes).to.equal("20");
    expect(at("10", 0).label).to.equal("__deprecated_pendingConfiscationWallet");
    expect(layout.types[at("10", 0).type].numberOfBytes).to.equal("20");
    expect(at("11", 0).label).to.equal("__deprecated_confiscationWalletScheduledAt");
    expect(layout.types[at("11", 0).type].numberOfBytes).to.equal("32");
  });

  it("appends nothing into the reserved range — slot 12 is the next free slot", async function () {
    // The reserved slots hold stale values on chains that used the old feature.
    // Anything placed there would silently read that stale data as its initial
    // value, which is the whole failure mode this file exists to prevent.
    const layout = compiledLayout();
    const maxSlot = Math.max(...layout.storage.map((v: any) => Number(v.slot)));
    expect(maxSlot).to.equal(11);
  });

  it("no longer exposes the retired getters", async function () {
    const { idrp } = await loadFixture(deployFixture);
    const names = idrp.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => (f as any).name);
    expect(names).to.not.include("confiscationWallet");
    expect(names).to.not.include("pendingConfiscationWallet");
    expect(names).to.not.include("confiscationWalletScheduledAt");
  });

  // ───────────────────────────────────────────────────────────────────────
  // The regression itself, driven by real deployed bytes.
  // ───────────────────────────────────────────────────────────────────────

  it("keeps the freeze gate enforced against Kairos's real slot-9 value", async function () {
    // THE test. Slot 9 is loaded with the exact word the Kairos proxy holds
    // today. If the retired address were deleted instead of reserved, the flag
    // would sit at byte 0 and read 0xcb — true — and this transfer would go
    // through.
    const { idrp, alice, bob } = await frozenFixture();
    await hre.network.provider.send("hardhat_setStorageAt", [
      await idrp.getAddress(),
      "0x9",
      KAIROS_SLOT_9,
    ]);

    await expect(
      idrp.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("still detects a genuinely-set flag at byte 20 — so the test above is not vacuous", async function () {
    // Same word, byte 20 flipped to 0x01. The gate must now open. Without this,
    // the test above would pass even if `_update` had stopped reading the flag
    // at all, and would be worth nothing.
    const { idrp, alice, bob } = await frozenFixture();
    await hre.network.provider.send("hardhat_setStorageAt", [
      await idrp.getAddress(),
      "0x9",
      KAIROS_SLOT_9_FLAG_SET,
    ]);

    await idrp.connect(alice).transfer(bob.address, idrp6("1"));
    expect(await idrp.balanceOf(bob.address)).to.equal(idrp6("1"));
  });

  it("leaves the flag clear on a fresh proxy", async function () {
    const { idrp, alice, bob } = await frozenFixture();
    const slot9 = await hre.ethers.provider.getStorage(await idrp.getAddress(), 9);
    expect(slot9).to.equal(hre.ethers.ZeroHash);
    await expect(
      idrp.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Everything that was already there must still read correctly.
  // ───────────────────────────────────────────────────────────────────────

  it("keeps every pre-existing slot readable and correct", async function () {
    const { idrp, admin, depository } = await loadFixture(deployFixture);
    expect(await idrp.admin()).to.equal(admin.address);
    expect(await idrp.upgrader()).to.equal(admin.address);
    expect(await idrp.depositoryWallet()).to.equal(depository.address);
    expect(await idrp.maxSupply()).to.equal(0n);
    expect(await idrp.sanctionsList()).to.equal(hre.ethers.ZeroAddress);
    expect(await idrp.decimals()).to.equal(6);
  });

  it("is a layout-compatible upgrade of itself (append-only check)", async function () {
    const { idrp, IDRPFactory } = await loadFixture(deployFixture);
    await hre.upgrades.validateUpgrade(await idrp.getAddress(), IDRPFactory, {
      kind: "uups",
    });
  });
});

import fs from "fs";
import path from "path";
import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Storage layout after the retired confiscation-wallet slots were DELETED
 * rather than reserved.
 *
 * WHAT THE FORK EXPERIMENT ESTABLISHED (test/confiscate/RemovalExperiment.ts,
 * run against live Kairos):
 *
 *  - The bypass flag does NOT land on the retired address's low byte. With the
 *    address gone, Solidity packs the bool into `controller`'s slot at byte 20,
 *    and byte 20 of a 20-byte address is always zero. The freeze gate keeps
 *    working. The earlier fear that it would read `0xcb` as `true` was wrong.
 *  - The real hazard is the ORPHAN: slot 9 keeps holding the retired address,
 *    unreferenced, so the next variable appended to this contract would read it
 *    as an initial value. `initializeV4` scrubs it during the upgrade.
 *
 * These tests pin both halves so neither can regress silently.
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

  it("packs the bypass flag into byte 20 of controller's slot", async function () {
    const layout = compiledLayout()
    const flag = layout.storage.find((v: any) => v.label === "_inConfiscation")
    const controller = layout.storage.find((v: any) => v.label === "controller")
    expect(flag, "_inConfiscation is gone from storage entirely").to.not.equal(undefined)
    expect(flag.slot).to.equal(controller.slot)
    expect(controller.offset).to.equal(0)
    expect(flag.offset).to.equal(20)
  })

  it("declares no placeholders, and ends at slot 8", async function () {
    const layout = compiledLayout()
    for (const v of layout.storage) {
      expect(v.label, `unexpected placeholder ${v.label}`).to.not.match(/^__deprecated_/)
    }
    const maxSlot = Math.max(...layout.storage.map((v: any) => Number(v.slot)))
    expect(maxSlot, "the next appended variable must land on slot 9").to.equal(8)
  })

  it("ignores the retired word entirely — it is no longer wired to anything", async function () {
    // Kairos's real slot 9, loaded onto a test proxy. Nothing reads it now, so
    // the freeze gate must be completely unaffected by its presence.
    const { idrp, alice, bob } = await frozenFixture()
    await hre.network.provider.send("hardhat_setStorageAt", [
      await idrp.getAddress(),
      "0x9",
      KAIROS_SLOT_9,
    ])
    await expect(
      idrp.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount")
  })

  it("still detects a genuinely-set flag — so the test above is not vacuous", async function () {
    // Byte 20 of CONTROLLER's slot is where the flag lives now. Set it and the
    // gate must open, or the test above proves nothing.
    const { idrp, admin, alice, bob } = await frozenFixture()
    const proxy = await idrp.getAddress()
    const slot8 = await hre.ethers.provider.getStorage(proxy, 8)
    const bytes = slot8.slice(2).match(/../g)!          // bytes[0] most significant
    bytes[31 - 20] = "01"                                 // flip the flag on
    await hre.network.provider.send("hardhat_setStorageAt", [
      proxy,
      "0x8",
      "0x" + bytes.join(""),
    ])
    expect(await idrp.controller(), "controller must survive the byte edit").to.equal(
      admin.address,
    )

    await idrp.connect(alice).transfer(bob.address, idrp6("1"))
    expect(await idrp.balanceOf(bob.address)).to.equal(idrp6("1"))
  })

  it("initializeV4 scrubs the retired slots so the next variable starts clean", async function () {
    const { idrp, admin } = await frozenFixture()
    const proxy = await idrp.getAddress()
    for (const [slot, word] of [
      ["0x9", KAIROS_SLOT_9],
      ["0xa", "0x" + "0".repeat(60) + "dead"],
      ["0xb", "0x" + "0".repeat(56) + "deadbeef"],
    ] as const) {
      await hre.network.provider.send("hardhat_setStorageAt", [proxy, slot, word])
    }

    await expect((idrp.connect(admin) as any).initializeV4()).to.emit(
      idrp,
      "RetiredConfiscationStorageCleared",
    )

    for (const slot of [9, 10, 11]) {
      expect(await hre.ethers.provider.getStorage(proxy, slot)).to.equal(hre.ethers.ZeroHash)
    }
  })

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

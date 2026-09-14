/**
 * Merge gate for the confiscationWallet design.
 *
 * These are the invariants that must hold before this branch goes to a mainnet branch.
 * Written to be IDENTICAL on the EVM (OZ5) and Tron (OZ4) lineages: every storage
 * assertion is expressed RELATIVE to `controller`'s slot, because the two layouts sit at
 * different absolute offsets (EVM 8/9, Tron 512/513) while the shape must match exactly.
 *
 * The gap this closes: the main confiscate suite points depositoryWallet and
 * confiscationWallet at the SAME address so its balance assertions stay readable. That
 * means those tests would still pass if `confiscate` were wired to the wrong variable.
 * Here the two wallets are always DISTINCT, so the destination is actually proven.
 */
import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import fs from "fs";
import path from "path";

const idrp6 = (n: string) => hre.ethers.parseUnits(n, 6);

/** Reads the compiler's own storage layout, resolved via the .dbg.json build-info. */
function layoutOfIDRP() {
  const dbg = JSON.parse(fs.readFileSync("artifacts/contracts/IDRP.sol/IDRP.dbg.json", "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.join("artifacts/contracts/IDRP.sol", dbg.buildInfo), "utf8"));
  return bi.output.contracts["contracts/IDRP.sol"].IDRP.storageLayout;
}
const entry = (L: any, label: string) => L.storage.find((v: any) => v.label === label);

describe("MERGE GATE — confiscationWallet is the seizure destination", function () {
  /**
   * depository and confiscation are DIFFERENT addresses here, deliberately.
   * `controller` is wired to a signer so seizures can be driven directly; the quorum
   * path itself is covered in test/confiscate/Confiscate.ts.
   */
  async function fx() {
    const [admin, depository, confiscation, badActor, other] = await hre.ethers.getSigners();
    const IDRP = await hre.ethers.getContractFactory("IDRP");
    const idrp: any = await hre.upgrades.deployProxy(IDRP, [admin.address]);
    await idrp.waitForDeployment();

    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address); // drive operations directly
    await idrp.connect(admin).mint(idrp6("1000"));          // mint lands on depositoryWallet
    await idrp.connect(depository).transfer(badActor.address, idrp6("400"));
    return { idrp, admin, depository, confiscation, badActor, other };
  }

  async function frozen() {
    const c = await loadFixture(fx);
    await c.idrp.connect(c.admin).setConfiscationWallet(c.confiscation.address);
    await c.idrp.connect(c.admin).freeze(c.badActor.address);
    return c;
  }

  // ── storage shape ────────────────────────────────────────────────────────────
  it("appends confiscationWallet without moving anything, and keeps the freeze flag packed", async function () {
    await hre.run("compile");
    const L = layoutOfIDRP();
    const ctrl = entry(L, "controller");
    const flag = entry(L, "_inConfiscation");
    const dest = entry(L, "confiscationWallet");
    expect(ctrl, "controller is gone").to.not.equal(undefined);
    expect(dest, "confiscationWallet is gone").to.not.equal(undefined);

    // The flag must stay in controller's word. A live proxy holds `controller` in the low
    // 20 bytes of it, so if the flag ever moved onto a different byte it could read a
    // stale non-zero value as `true` and silently disable the freeze gate.
    expect(Number(flag.slot), "_inConfiscation left controller's slot").to.equal(Number(ctrl.slot));
    expect(Number(flag.offset), "_inConfiscation changed offset").to.equal(20);

    // The destination is the only new slot, and it must APPEND.
    expect(Number(dest.slot), "confiscationWallet must be the very next slot").to.equal(Number(ctrl.slot) + 1);
    expect(Number(dest.offset), "confiscationWallet must start a fresh word").to.equal(0);
    const max = Math.max(...L.storage.map((v: any) => Number(v.slot)));
    expect(max, "something landed past confiscationWallet").to.equal(Number(dest.slot));

    // Order of the pre-existing variables is what pins "nothing shifted".
    const appVars = L.storage
      .filter((v: any) => Number(v.slot) >= Number(entry(L, "frozen").slot))
      .sort((a: any, b: any) => Number(a.slot) - Number(b.slot) || Number(a.offset) - Number(b.offset))
      .map((v: any) => v.label);
    expect(appVars).to.deep.equal([
      "frozen", "depositoryWallet", "maxSupply", "upgrader", "upgradeScheduledAt",
      "scheduledImplementation", "sanctionsList", "admin", "controller", "_inConfiscation",
      "confiscationWallet",
    ]);
    for (const v of L.storage) {
      expect(v.label, `placeholder left behind: ${v.label}`).to.not.match(/^__deprecated_/);
    }
  });

  // ── the destination is actually confiscationWallet ───────────────────────────
  it("seizes into confiscationWallet and leaves depositoryWallet untouched", async function () {
    const { idrp, admin, depository, confiscation, badActor } = await frozen();
    expect(confiscation.address, "fixture must keep the two wallets distinct").to.not.equal(depository.address);

    const depBefore = await idrp.balanceOf(depository.address);
    const seized = await idrp.balanceOf(badActor.address);
    const supply = await idrp.totalSupply();

    await idrp.connect(admin).confiscate(badActor.address, seized);

    expect(await idrp.balanceOf(confiscation.address), "funds did not land on confiscationWallet").to.equal(seized);
    expect(await idrp.balanceOf(depository.address), "depositoryWallet was touched").to.equal(depBefore);
    expect(await idrp.balanceOf(badActor.address)).to.equal(0n);
    expect(await idrp.totalSupply(), "a seizure must be a transfer, never a burn/mint").to.equal(supply);
  });

  it("emits AssetsConfiscated naming the confiscation wallet as destination", async function () {
    const { idrp, admin, confiscation, badActor } = await frozen();
    const seized = await idrp.balanceOf(badActor.address);
    await expect(idrp.connect(admin).confiscate(badActor.address, seized))
      .to.emit(idrp, "AssetsConfiscated")
      .withArgs(badActor.address, confiscation.address, seized);
  });

  it("follows confiscationWallet when it moves", async function () {
    const { idrp, admin, other, badActor } = await frozen();
    await idrp.connect(admin).setConfiscationWallet(other.address);
    const seized = await idrp.balanceOf(badActor.address);
    await idrp.connect(admin).confiscate(badActor.address, seized);
    expect(await idrp.balanceOf(other.address)).to.equal(seized);
  });

  it("ignores depositoryWallet entirely — moving it does not move a seizure", async function () {
    const { idrp, admin, confiscation, other, badActor } = await frozen();
    await idrp.connect(admin).setDepositoryWallet(other.address); // re-point the depository
    const seized = await idrp.balanceOf(badActor.address);
    await idrp.connect(admin).confiscate(badActor.address, seized);
    expect(await idrp.balanceOf(confiscation.address), "seizure followed the depository").to.equal(seized);
    expect(await idrp.balanceOf(other.address), "new depository received seized funds").to.equal(0n);
  });

  // ── the unset state a migrated proxy always starts in ────────────────────────
  it("starts unset, and a seizure reverts until a destination is chosen", async function () {
    const { idrp, admin, badActor } = await loadFixture(fx);
    // confiscationWallet appends onto a previously-empty slot, so every upgraded proxy
    // arrives here. This is the first thing to do after any upgrade.
    expect(await idrp.confiscationWallet()).to.equal(hre.ethers.ZeroAddress);
    await idrp.connect(admin).freeze(badActor.address);
    await expect(
      idrp.connect(admin).confiscate(badActor.address, idrp6("1"))
    ).to.be.revertedWith("Confiscation wallet not set");
    await idrp.connect(admin).setConfiscationWallet((await hre.ethers.getSigners())[2].address);
    await idrp.connect(admin).confiscate(badActor.address, idrp6("1")); // now succeeds
  });

  it("refuses to seize from the destination itself", async function () {
    const { idrp, admin, confiscation, depository } = await loadFixture(fx);
    await idrp.connect(admin).setConfiscationWallet(confiscation.address);
    await idrp.connect(depository).transfer(confiscation.address, idrp6("10"));
    await idrp.connect(admin).freeze(confiscation.address);
    await expect(
      idrp.connect(admin).confiscate(confiscation.address, idrp6("1"))
    ).to.be.revertedWith("Cannot confiscate from the destination");
  });

  // ── authority ────────────────────────────────────────────────────────────────
  it("keeps the destination admin-only and the seizure controller-only", async function () {
    const { idrp, admin, other, confiscation, badActor } = await frozen();
    await expect(
      idrp.connect(other).setConfiscationWallet(other.address)
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");
    // admin is the wired controller in this fixture, so use a third party for the seizure.
    await expect(
      idrp.connect(other).confiscate(badActor.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "NotController");
    expect(await idrp.confiscationWallet()).to.equal(confiscation.address);
  });

  it("re-closes the freeze gate after a seizure", async function () {
    const { idrp, admin, badActor, other, depository } = await frozen();
    await idrp.connect(admin).confiscate(badActor.address, idrp6("1"));
    // badActor is still frozen, and the bypass flag must not have been left set.
    await expect(
      idrp.connect(badActor).transfer(other.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    // and an ordinary account still moves normally
    await idrp.connect(depository).transfer(other.address, 1n);
    expect(await idrp.balanceOf(other.address)).to.equal(1n);
  });

  it("exposes no timelock machinery for the destination", async function () {
    const { idrp } = await loadFixture(fx);
    for (const fn of ["scheduleConfiscationWallet", "applyConfiscationWallet",
                      "cancelConfiscationWallet", "pendingConfiscationWallet",
                      "confiscationWalletScheduledAt"]) {
      expect((idrp as any).interface.hasFunction(fn),
        `${fn} exists — the destination was put behind a timelock; see docs/design/confiscation-wallet-no-timelock.md`
      ).to.equal(false);
    }
    // the UPGRADE path must still be timelocked — this is not a blanket removal
    for (const fn of ["scheduleUpgrade", "cancelUpgrade", "UPGRADE_DELAY"]) {
      expect((idrp as any).interface.hasFunction(fn), `${fn} disappeared`).to.equal(true);
    }
  });

  // ── the actual mainnet upgrade path, checked by OZ's own validator ───────────
  describe("upgrade safety from what is deployed today", function () {
    /**
     * Skips rather than passes where a legacy factory does not exist on this branch.
     * A silently-skipped check is visible in the reporter; a silently-passing one is not.
     */
    async function factoryOrSkip(ctx: Mocha.Context, name: string) {
      try { return await hre.ethers.getContractFactory(name); }
      catch { ctx.skip(); }
    }

    it("checks this build against what mainnet runs TODAY", async function () {
      // The two lineages start from different implementations AND have different
      // expected verdicts, so both are stated explicitly. A single "it validates"
      // assertion would either be wrong on Tron or have to be weakened to nothing.
      //
      //   EVM  — from IDRPv3NoConfiscate (live on all four EVM mainnets): must PASS.
      //   Tron — from IDRPv2 (live on the Tron mainnet token): OZ REJECTS it, because
      //          v2 -> v3 drops the AccessControl `_roles` and ERC165 `__gap` NAMES.
      //          Their space is kept, as `__legacyAccessControlGap` — a 100-slot
      //          reservation asserted exactly in test/upgrade/TronBattleTest.ts. OZ has
      //          no annotation for "deleted the name, kept the space", so it refuses on
      //          principle. That is a tool limitation, not a verdict about the chain,
      //          and the chain is covered independently: TronBattleTest drives a REAL
      //          v2 -> v3 upgrade plus a second hop and asserts every value survives,
      //          DOMAIN_SEPARATOR included. Measured beats validated here.
      let From: any, which = "";
      for (const name of ["IDRPv3NoConfiscate", "IDRPv2"]) {
        try { From = await hre.ethers.getContractFactory(name); which = name; break; } catch { /* next */ }
      }
      if (!From) this.skip();
      const To = await hre.ethers.getContractFactory("IDRP");
      const run = () => hre.upgrades.validateUpgrade(From, To, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call"],   // no layout waiver, deliberately
      });

      if (which === "IDRPv3NoConfiscate") {
        await run();   // must pass outright — this is the EVM mainnet upgrade path
        return;
      }
      // Tron: assert the rejection is the KNOWN one and nothing new has crept in.
      let msg = "";
      try { await run(); } catch (e: any) { msg = e.message; }
      expect(msg, "OZ accepted the Tron path — the legacy reservation may have changed").to.not.equal("");
      expect(msg, "rejected for a reason other than the known deleted legacy names")
        .to.match(/Deleted `_roles`|Deleted `__gap`/);
      expect(msg, "a NEW deletion appeared beyond the known legacy names")
        .to.not.match(/Deleted `(depositoryWallet|maxSupply|upgrader|sanctionsList|admin|controller|frozen)`/);
    });

    it("is still un-validatable from the PLACEHOLDER lineage — expected, and already behind us", async function () {
      // Pinned as a rejection rather than quietly dropped, because the reason matters.
      // OZ has no annotation that expresses a storage DELETION, so it refuses every
      // placeholder -> clean transition regardless of whether the chain is safe. That
      // is a tool limitation, not a verdict about the chain.
      //
      // It does not block anything here: Base Sepolia and Kairos already made that
      // jump in place, so both now run the CLEAN layout, and the clean -> this-build
      // path is the one exercised above and by test/confiscate/UpgradeSafety.ts
      // (a real upgrade through the timelock, with the retired slots dirtied first).
      //
      // If this ever starts PASSING, the placeholders came back — find out why.
      const From = await factoryOrSkip(this, "IDRPWithRetiredSlots");
      const To = await hre.ethers.getContractFactory("IDRP");
      let rejected = false;
      try {
        await hre.upgrades.validateUpgrade(From as any, To, {
          kind: "uups",
          unsafeAllow: ["missing-initializer-call"],
        });
      } catch (e: any) {
        rejected = true;
        expect(e.message, "rejected for an unexpected reason").to.match(/Deleted `__deprecated_/);
      }
      expect(rejected, "OZ accepted a storage deletion — the placeholders are back").to.equal(true);
    });
  });
});

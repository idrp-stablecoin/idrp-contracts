import fs from "fs";
import path from "path";
import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Storage layout for confiscation on the TRON lineage (OpenZeppelin 4.9.6).
 *
 * WHY THIS IS NOT A COPY OF THE EVM TEST
 *
 * The EVM branch carries three `__deprecated_*` placeholders because one EVM
 * testnet deployed an earlier design that stored a separate confiscation wallet,
 * and that chain's slot still holds the address. Tron never ran that design, so
 * there is nothing to reserve and nothing to protect against — the layout here
 * is clean by right, not by accident.
 *
 * WHAT DOES NEED WATCHING HERE
 *
 * OZ 4 lays this contract out sequentially, so the token's own variables start
 * at slot 504 and `controller` lands on 512 — an `address`, 20 bytes. The bool
 * therefore PACKS into byte 20 of `controller`'s slot rather than taking one of
 * its own. That is the same shape that nearly disabled the freeze gate on the
 * EVM side, so it is asserted rather than assumed: byte 20 of a 20-byte address
 * is zero, so the flag reads false no matter which controller is wired.
 *
 * Verified on-chain 2026-09-05: slots 511, 512 and 513 all read zero on Tron
 * mainnet AND Nile, both of which are still v2 and have never written them.
 */
describe("Confiscate — storage layout on the Tron/OZ4 lineage", function () {
  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  async function deployFixture() {
    const [admin, depository, alice, bob] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    return { idrp, IDRPFactory, admin, depository, alice, bob };
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

  it("carries NO deprecated placeholders — those are an EVM-only concern", async function () {
    const labels = compiledLayout().storage.map((v: any) => v.label);
    for (const label of labels) {
      expect(label, `unexpected placeholder ${label} on the Tron lineage`).to.not.match(
        /^__deprecated_/
      );
    }
  });

  it("packs the bypass flag into byte 20 of controller's slot", async function () {
    const layout = compiledLayout();
    const flag = layout.storage.find((v: any) => v.label === "_inConfiscation");
    const controller = layout.storage.find((v: any) => v.label === "controller");
    expect(flag, "_inConfiscation is gone from storage entirely").to.not.equal(undefined);
    // Same slot as `controller`, one byte above it.
    expect(flag.slot).to.equal(controller.slot);
    expect(controller.offset).to.equal(0);
    expect(flag.offset).to.equal(20);
  });

  it("keeps the freeze gate shut with a real controller address in the same slot", async function () {
    // THE test for this lineage. `controller` is 20 bytes, so byte 20 of its
    // slot is zero and the packed flag reads false — for ANY controller address.
    // If the flag ever moved to byte 0 it would read the address's low byte as
    // `true` and stop enforcing the gate on every transfer, silently.
    const { idrp, admin, depository, alice, bob } = await loadFixture(deployFixture);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000"));
    await idrp.connect(depository).transfer(alice.address, idrp6("1000"));
    await idrp.connect(admin).freeze(alice.address);

    const layout = compiledLayout();
    const slot = Number(
      layout.storage.find((v: any) => v.label === "controller").slot
    );
    const word = await hre.ethers.provider.getStorage(await idrp.getAddress(), slot);
    const bytes = word.slice(2).match(/../g)!; // bytes[0] is most significant
    expect(bytes[31 - 0], "controller's low byte should be nonzero").to.not.equal("00");
    expect(bytes[31 - 20], "byte 20 must be clear or the flag reads true").to.equal("00");

    await expect(
      idrp.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("clears the flag again after a seizure", async function () {
    const { idrp, admin, depository, alice, bob } = await loadFixture(deployFixture);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000"));
    await idrp.connect(depository).transfer(alice.address, idrp6("1000"));
    await idrp.connect(admin).freeze(alice.address);

    await idrp.connect(admin).confiscate(alice.address, idrp6("1000"));
    expect(await idrp.balanceOf(depository.address)).to.equal(idrp6("1000"));

    // Gate re-sealed, and the controller in the shared slot is untouched.
    expect(await idrp.controller()).to.equal(admin.address);
    await expect(
      idrp.connect(bob).transfer(alice.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("is a layout-compatible upgrade of itself (append-only check)", async function () {
    const { idrp, IDRPFactory } = await loadFixture(deployFixture);
    await hre.upgrades.validateUpgrade(await idrp.getAddress(), IDRPFactory, {
      kind: "uups",
    });
  });
});

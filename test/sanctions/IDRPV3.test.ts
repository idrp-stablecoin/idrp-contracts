import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Tests for IDRPV3 — IDRP with on-chain sanctions enforcement wired into _update.
 *
 * Coverage:
 *   1. Default state: when sanctionsRegistry is unset, V3 behaves identically to V2.
 *   2. setSanctionsRegistry — access control + event + state.
 *   3. Enforcement: transfers from/to sanctioned addresses revert with the
 *      right custom errors. Transfers between non-sanctioned addresses succeed.
 *   4. Mint and burn paths intentionally skip sanctions (gated by their own roles).
 *   5. Existing freeze / pause / role admin behaviors still work (no regression).
 *   6. Hot-swap: registry can be replaced or disabled (set to address(0)).
 */
describe("IDRPV3 — sanctions enforcement", function () {
  const CAT_FOREIGN_GOV_LIST = 6;

  async function deployFixture() {
    const [superAdmin, alice, bob, carol, sanctionedAddr] = await hre.ethers.getSigners();

    // Deploy V3 fresh via UUPS proxy.
    const IDRPV3Factory = await hre.ethers.getContractFactory("IDRPV3");
    const idrp = await hre.upgrades.deployProxy(IDRPV3Factory, [superAdmin.address]);
    await idrp.waitForDeployment();

    // Deploy a fresh sanctions registry; the superAdmin is both multisig and keeper.
    const RegFactory = await hre.ethers.getContractFactory("IDRPSanctionsRegistry");
    const registry = await RegFactory.deploy(superAdmin.address, superAdmin.address);
    await registry.waitForDeployment();

    // Give alice some IDRP to play with — set depository, mint, then transfer to alice.
    await idrp.connect(superAdmin).setDepositoryWallet(superAdmin.address);
    await idrp.connect(superAdmin).mint(1_000_000n);
    await idrp.connect(superAdmin).transfer(alice.address, 100_000n);

    return { idrp, registry, superAdmin, alice, bob, carol, sanctionedAddr };
  }

  describe("default state (registry not wired)", function () {
    it("has sanctionsRegistry == address(0) on a fresh deploy", async function () {
      const { idrp } = await loadFixture(deployFixture);
      expect(await idrp.sanctionsRegistry()).to.equal(hre.ethers.ZeroAddress);
    });

    it("transfers proceed normally — no sanctions check overhead", async function () {
      const { idrp, alice, bob } = await loadFixture(deployFixture);
      await expect(idrp.connect(alice).transfer(bob.address, 1_000n)).to.not.be.reverted;
      expect(await idrp.balanceOf(bob.address)).to.equal(1_000n);
    });

    it("freeze still works (V2 mechanism unchanged)", async function () {
      const { idrp, superAdmin, alice, bob } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).freeze(alice.address);
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
        idrp,
        "FrozenAccount"
      );
    });
  });

  describe("setSanctionsRegistry", function () {
    it("only DEFAULT_ADMIN_ROLE can wire the registry", async function () {
      const { idrp, registry, alice } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(alice).setSanctionsRegistry(await registry.getAddress())
      ).to.be.revertedWithCustomError(idrp, "AccessControlUnauthorizedAccount");
    });

    it("emits SanctionsRegistryUpdated with both previous and next addresses", async function () {
      const { idrp, registry, superAdmin } = await loadFixture(deployFixture);
      const regAddr = await registry.getAddress();
      await expect(idrp.connect(superAdmin).setSanctionsRegistry(regAddr))
        .to.emit(idrp, "SanctionsRegistryUpdated")
        .withArgs(hre.ethers.ZeroAddress, regAddr);
    });

    it("can be set to a new registry address (hot-swap)", async function () {
      const { idrp, registry, superAdmin } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsRegistry(await registry.getAddress());

      const RegFactory = await hre.ethers.getContractFactory("IDRPSanctionsRegistry");
      const registry2 = await RegFactory.deploy(superAdmin.address, superAdmin.address);
      await registry2.waitForDeployment();
      const reg2Addr = await registry2.getAddress();

      await expect(idrp.connect(superAdmin).setSanctionsRegistry(reg2Addr))
        .to.emit(idrp, "SanctionsRegistryUpdated")
        .withArgs(await registry.getAddress(), reg2Addr);

      expect(await idrp.sanctionsRegistry()).to.equal(reg2Addr);
    });

    it("can be cleared back to address(0) — kill switch", async function () {
      const { idrp, registry, superAdmin, alice, bob } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsRegistry(await registry.getAddress());
      await registry
        .connect(superAdmin)
        .addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "test");

      // With registry wired + alice sanctioned: transfer would fail.
      await expect(
        idrp.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(idrp, "SanctionedSender");

      // Flip the kill switch.
      await idrp.connect(superAdmin).setSanctionsRegistry(hre.ethers.ZeroAddress);

      // Now the same transfer goes through.
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;
    });
  });

  describe("transfer enforcement (registry wired)", function () {
    async function wiredFixture() {
      const f = await deployFixture();
      await f.idrp.connect(f.superAdmin).setSanctionsRegistry(await f.registry.getAddress());
      return f;
    }

    it("blocks transfer FROM a sanctioned address with SanctionedSender", async function () {
      const { idrp, registry, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await registry
        .connect(superAdmin)
        .addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "OpenSanctions:NBCTF");

      await expect(idrp.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(idrp, "SanctionedSender")
        .withArgs(alice.address);
    });

    it("blocks transfer TO a sanctioned address with SanctionedRecipient", async function () {
      const { idrp, registry, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await registry
        .connect(superAdmin)
        .addSanctioned(bob.address, CAT_FOREIGN_GOV_LIST, "OpenSanctions:NBCTF");

      await expect(idrp.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(idrp, "SanctionedRecipient")
        .withArgs(bob.address);
    });

    it("transfer between two non-sanctioned addresses succeeds", async function () {
      const { idrp, alice, bob } = await loadFixture(wiredFixture);
      await expect(idrp.connect(alice).transfer(bob.address, 5_000n)).to.not.be.reverted;
      expect(await idrp.balanceOf(bob.address)).to.equal(5_000n);
    });

    it("removing sanction unblocks the transfer", async function () {
      const { idrp, registry, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await registry
        .connect(superAdmin)
        .addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "test");
      await registry.connect(superAdmin).removeSanctioned(alice.address);

      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;
    });

    it("transferFrom (allowance flow) is also gated", async function () {
      const { idrp, registry, superAdmin, alice, bob, carol } = await loadFixture(wiredFixture);
      await idrp.connect(alice).approve(bob.address, 1_000n);
      await registry
        .connect(superAdmin)
        .addSanctioned(carol.address, CAT_FOREIGN_GOV_LIST, "test");

      await expect(
        idrp.connect(bob).transferFrom(alice.address, carol.address, 1n)
      ).to.be.revertedWithCustomError(idrp, "SanctionedRecipient");
    });

    it("freeze and sanctions both apply — freeze fires first if both true", async function () {
      const { idrp, registry, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await idrp.connect(superAdmin).freeze(alice.address);
      await registry
        .connect(superAdmin)
        .addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "test");

      // Freeze check runs before sanctions — so we expect FrozenAccount, not SanctionedSender.
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
        idrp,
        "FrozenAccount"
      );
    });
  });

  describe("mint / burn intentionally skip sanctions", function () {
    it("mint to depository succeeds even if depository ends up sanctioned (only frozen blocks it)", async function () {
      const { idrp, registry, superAdmin } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsRegistry(await registry.getAddress());

      // Sanction the depository wallet — mint should still proceed because mint
      // sets `from = address(0)`, which the _update guard short-circuits.
      await registry
        .connect(superAdmin)
        .addSanctioned(superAdmin.address, CAT_FOREIGN_GOV_LIST, "test");

      await expect(idrp.connect(superAdmin).mint(100n)).to.not.be.reverted;
    });

    it("burn from a sanctioned address still works (used for seizure)", async function () {
      const { idrp, registry, superAdmin, alice } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsRegistry(await registry.getAddress());

      // alice has 100_000 IDRP from fixture setup; sanction her, then burn.
      await registry
        .connect(superAdmin)
        .addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "test");

      // alice must approve the minter to burn her tokens.
      await idrp.connect(alice).approve(superAdmin.address, 100n);

      // burn → _burn → _update with `to = address(0)`, which the _update guard short-circuits.
      await expect(idrp.connect(superAdmin).burn(alice.address, 100n)).to.not.be.reverted;
      expect(await idrp.balanceOf(alice.address)).to.equal(99_900n);
    });
  });

  describe("V2 features still work (no regression)", function () {
    it("pause still blocks transfers", async function () {
      const { idrp, superAdmin, alice, bob } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).pause();
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
        idrp,
        "EnforcedPause"
      );
    });

    it("decimals still 6", async function () {
      const { idrp } = await loadFixture(deployFixture);
      expect(await idrp.decimals()).to.equal(6);
    });

    it("max supply enforcement still works", async function () {
      const { idrp, superAdmin } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setMaxSupply(1_000_000n); // current supply already
      await expect(idrp.connect(superAdmin).mint(1n)).to.be.revertedWith("Exceeds max supply");
    });
  });

  describe("gas overhead from sanctions wiring", function () {
    it("a transfer with registry unwired vs wired — measure the delta", async function () {
      const { idrp, registry, superAdmin, alice, bob } = await loadFixture(deployFixture);

      // Warm bob's balance slot first so both subsequent measurements are
      // non-zero → non-zero SSTOREs. Without this, the baseline transfer pays
      // ~22.1k gas for a zero → non-zero write and the wired transfer pays
      // only ~5k, masking the sanctions overhead.
      await idrp.connect(alice).transfer(bob.address, 1n);

      // Baseline (registry NOT wired) — both balance slots are warm.
      const t1 = await idrp.connect(alice).transfer(bob.address, 1n);
      const r1 = await t1.wait();

      // Wire the registry. New registry → new contract address; first call to
      // it pays the cold STATICCALL + cold SLOAD. That's the realistic per-tx
      // cost for the FIRST transfer in any new transaction (since each tx
      // starts cold).
      await idrp.connect(superAdmin).setSanctionsRegistry(await registry.getAddress());

      const t2 = await idrp.connect(alice).transfer(bob.address, 1n);
      const r2 = await t2.wait();

      const delta = (r2?.gasUsed ?? 0n) - (r1?.gasUsed ?? 0n);
      console.log(`        baseline transfer: ${r1?.gasUsed} gas`);
      console.log(`        wired transfer   : ${r2?.gasUsed} gas`);
      console.log(`        sanctions delta  : ${delta} gas (one cold STATICCALL + one cold SLOAD per side)`);

      // Chat predicted ~6.9k extra cold-path gas. Reality should be in that
      // ballpark — looser bound here because the implementation cost depends on
      // whether the registry's `_entries` slot for these specific addresses is
      // warm or cold (always cold at tx start).
      expect(delta).to.be.within(3_000n, 12_000n);
    });
  });
});

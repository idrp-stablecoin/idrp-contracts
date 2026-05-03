import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Tests for IDRP's on-chain sanctions enforcement wired into `_update`.
 *
 * IDRP holds a single pluggable pointer (`address public sanctionsList`) to a
 * Chainalysis-ABI-compatible contract. When set, every regular transfer makes
 * two STATICCALLs to `isSanctioned(from)` and `isSanctioned(to)` and reverts
 * with `SanctionedSender` / `SanctionedRecipient` if either is flagged.
 *
 * For our deployment that means:
 *   - On Ethereum / BSC / Polygon: point at the real Chainalysis oracle.
 *   - On Kaia: point at our SanctionsList.sol clone.
 *   - These tests exercise our clone but would pass against Chainalysis on a
 *     fork — the only contract surface IDRP touches is `isSanctioned(address)`.
 *
 * Coverage:
 *   1. Default state: when `sanctionsList` is unset, IDRP behaves as before.
 *   2. setSanctionsList — access control + event + state.
 *   3. Hot-swap and kill switch (set to address(0)).
 *   4. Enforcement: transfers from/to sanctioned addresses revert with the
 *      right custom errors. Transfers between non-sanctioned addresses succeed.
 *   5. Mint and burn paths intentionally skip sanctions (gated by their own roles).
 *   6. Existing freeze / pause / role admin behaviors still work (no regression).
 *   7. Gas overhead measurement when wired vs unwired.
 */
describe("IDRP — sanctions enforcement", function () {
  async function deployFixture() {
    const [superAdmin, alice, bob, carol] = await hre.ethers.getSigners();

    // Deploy IDRP fresh via UUPS proxy.
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [superAdmin.address]);
    await idrp.waitForDeployment();

    // Deploy a fresh sanctions list — Chainalysis-clone contract; deployer is owner.
    const ListFactory = await hre.ethers.getContractFactory("SanctionsList");
    const list = await ListFactory.deploy();
    await list.waitForDeployment();

    // Give alice some IDRP — set depository, mint, then transfer to alice.
    await idrp.connect(superAdmin).setDepositoryWallet(superAdmin.address);
    await idrp.connect(superAdmin).mint(1_000_000n);
    await idrp.connect(superAdmin).transfer(alice.address, 100_000n);

    return { idrp, list, superAdmin, alice, bob, carol };
  }

  describe("default state (list not wired)", function () {
    it("has sanctionsList == address(0) on a fresh deploy", async function () {
      const { idrp } = await loadFixture(deployFixture);
      expect(await idrp.sanctionsList()).to.equal(hre.ethers.ZeroAddress);
    });

    it("transfers proceed normally — no sanctions check overhead", async function () {
      const { idrp, alice, bob } = await loadFixture(deployFixture);
      await expect(idrp.connect(alice).transfer(bob.address, 1_000n)).to.not.be.reverted;
      expect(await idrp.balanceOf(bob.address)).to.equal(1_000n);
    });

    it("freeze still works (existing mechanism unchanged)", async function () {
      const { idrp, superAdmin, alice, bob } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).freeze(alice.address);
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
        idrp,
        "FrozenAccount"
      );
    });
  });

  describe("setSanctionsList", function () {
    it("only DEFAULT_ADMIN_ROLE can wire the list", async function () {
      const { idrp, list, alice } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(alice).setSanctionsList(await list.getAddress())
      ).to.be.revertedWithCustomError(idrp, "AccessControlUnauthorizedAccount");
    });

    it("emits SanctionsListUpdated with both previous and next addresses", async function () {
      const { idrp, list, superAdmin } = await loadFixture(deployFixture);
      const listAddr = await list.getAddress();
      await expect(idrp.connect(superAdmin).setSanctionsList(listAddr))
        .to.emit(idrp, "SanctionsListUpdated")
        .withArgs(hre.ethers.ZeroAddress, listAddr);
    });

    it("can be set to a new list address (hot-swap, e.g. to point at Chainalysis later)", async function () {
      const { idrp, list, superAdmin } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsList(await list.getAddress());

      const ListFactory = await hre.ethers.getContractFactory("SanctionsList");
      const list2 = await ListFactory.deploy();
      await list2.waitForDeployment();
      const list2Addr = await list2.getAddress();

      await expect(idrp.connect(superAdmin).setSanctionsList(list2Addr))
        .to.emit(idrp, "SanctionsListUpdated")
        .withArgs(await list.getAddress(), list2Addr);

      expect(await idrp.sanctionsList()).to.equal(list2Addr);
    });

    it("can be cleared back to address(0) — kill switch", async function () {
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsList(await list.getAddress());
      await list.connect(superAdmin).addToSanctionsList([alice.address]);

      // With list wired + alice sanctioned: transfer would fail.
      await expect(
        idrp.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(idrp, "SanctionedSender");

      // Flip the kill switch.
      await idrp.connect(superAdmin).setSanctionsList(hre.ethers.ZeroAddress);

      // Now the same transfer goes through.
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;
    });
  });

  describe("transfer enforcement (list wired)", function () {
    async function wiredFixture() {
      const f = await deployFixture();
      await f.idrp.connect(f.superAdmin).setSanctionsList(await f.list.getAddress());
      return f;
    }

    it("blocks transfer FROM a sanctioned address with SanctionedSender", async function () {
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await list.connect(superAdmin).addToSanctionsList([alice.address]);

      await expect(idrp.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(idrp, "SanctionedSender")
        .withArgs(alice.address);
    });

    it("blocks transfer TO a sanctioned address with SanctionedRecipient", async function () {
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await list.connect(superAdmin).addToSanctionsList([bob.address]);

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
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await list.connect(superAdmin).addToSanctionsList([alice.address]);
      await list.connect(superAdmin).removeFromSanctionsList([alice.address]);

      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;
    });

    it("transferFrom (allowance flow) is also gated", async function () {
      const { idrp, list, superAdmin, alice, bob, carol } = await loadFixture(wiredFixture);
      await idrp.connect(alice).approve(bob.address, 1_000n);
      await list.connect(superAdmin).addToSanctionsList([carol.address]);

      await expect(
        idrp.connect(bob).transferFrom(alice.address, carol.address, 1n)
      ).to.be.revertedWithCustomError(idrp, "SanctionedRecipient");
    });

    it("freeze and sanctions both apply — freeze fires first if both true", async function () {
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      await idrp.connect(superAdmin).freeze(alice.address);
      await list.connect(superAdmin).addToSanctionsList([alice.address]);

      // Freeze check runs before sanctions — so we expect FrozenAccount, not SanctionedSender.
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
        idrp,
        "FrozenAccount"
      );
    });

    it("a hot-swap to a list with DIFFERENT sanctions takes effect on the next transfer", async function () {
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(wiredFixture);
      // alice not on the wired list — transfer succeeds.
      await expect(idrp.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;

      // Spin up a second list that DOES sanction alice and swap to it.
      const ListFactory = await hre.ethers.getContractFactory("SanctionsList");
      const list2 = await ListFactory.deploy();
      await list2.waitForDeployment();
      await list2.connect(superAdmin).addToSanctionsList([alice.address]);
      await idrp.connect(superAdmin).setSanctionsList(await list2.getAddress());

      // Now alice is blocked — IDRP read state straight from the new list.
      await expect(
        idrp.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(idrp, "SanctionedSender");
    });
  });

  describe("mint / burn intentionally skip sanctions", function () {
    it("mint to depository succeeds even if depository is on the sanctions list (only frozen blocks it)", async function () {
      const { idrp, list, superAdmin } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsList(await list.getAddress());

      // Sanction the depository wallet — mint should still proceed because mint
      // sets `from = address(0)`, which the _update guard short-circuits.
      await list.connect(superAdmin).addToSanctionsList([superAdmin.address]);

      await expect(idrp.connect(superAdmin).mint(100n)).to.not.be.reverted;
    });

    it("burn from a sanctioned address still works (used for seizure)", async function () {
      const { idrp, list, superAdmin, alice } = await loadFixture(deployFixture);
      await idrp.connect(superAdmin).setSanctionsList(await list.getAddress());

      // alice has 100_000 IDRP from fixture setup; sanction her, then burn.
      await list.connect(superAdmin).addToSanctionsList([alice.address]);

      // alice must approve the minter to burn her tokens.
      await idrp.connect(alice).approve(superAdmin.address, 100n);

      // burn → _burn → _update with `to = address(0)`, which the _update guard short-circuits.
      await expect(idrp.connect(superAdmin).burn(alice.address, 100n)).to.not.be.reverted;
      expect(await idrp.balanceOf(alice.address)).to.equal(99_900n);
    });
  });

  describe("existing IDRP features still work (no regression)", function () {
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
    it("a transfer with list unwired vs wired — measure the delta", async function () {
      const { idrp, list, superAdmin, alice, bob } = await loadFixture(deployFixture);

      // Warm bob's balance slot first so both subsequent measurements are
      // non-zero → non-zero SSTOREs. Without this, the baseline transfer pays
      // ~22.1k gas for a zero → non-zero write and the wired transfer pays
      // only ~5k, masking the sanctions overhead.
      await idrp.connect(alice).transfer(bob.address, 1n);

      // Baseline (list NOT wired) — both balance slots are warm.
      const t1 = await idrp.connect(alice).transfer(bob.address, 1n);
      const r1 = await t1.wait();

      // Wire the list. New list contract → new address; first call pays the
      // cold STATICCALL + cold SLOAD. That's the realistic per-tx cost for
      // the FIRST transfer in any new transaction (each tx starts cold).
      await idrp.connect(superAdmin).setSanctionsList(await list.getAddress());

      const t2 = await idrp.connect(alice).transfer(bob.address, 1n);
      const r2 = await t2.wait();

      const delta = (r2?.gasUsed ?? 0n) - (r1?.gasUsed ?? 0n);
      console.log(`        baseline transfer: ${r1?.gasUsed} gas`);
      console.log(`        wired transfer   : ${r2?.gasUsed} gas`);
      console.log(`        sanctions delta  : ${delta} gas (one cold STATICCALL + one cold SLOAD per side)`);

      // Chainalysis-clone storage layout is a single mapping slot — the
      // STATICCALL pays the cold address (~2.6k) + one cold SLOAD per side
      // (~2.1k each). Total ~6-9k.
      expect(delta).to.be.within(3_000n, 12_000n);
    });
  });
});

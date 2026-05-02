import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Functional tests for SanctionsList — IDRP's verbatim clone of the
 * Chainalysis sanctions oracle (deployed on Kaia, later Tron).
 *
 * Tests are written against the Chainalysis ABI. They should pass against
 * either our clone or the real Chainalysis contract on a forked chain.
 */
describe("SanctionsList — Chainalysis clone (functional)", function () {
  async function deployFixture() {
    const [owner, alice, bob, carol, attacker] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("SanctionsList");
    const list = await Factory.deploy();
    await list.waitForDeployment();
    return { list, owner, alice, bob, carol, attacker };
  }

  describe("deployment", function () {
    it("deployer becomes owner", async function () {
      const { list, owner } = await loadFixture(deployFixture);
      expect(await list.owner()).to.equal(owner.address);
    });

    it("name() returns the Chainalysis-identical string", async function () {
      const { list } = await loadFixture(deployFixture);
      expect(await list.name()).to.equal("Chainalysis sanctions oracle");
    });

    it("isSanctioned returns false for any unknown address", async function () {
      const { list, alice } = await loadFixture(deployFixture);
      expect(await list.isSanctioned(alice.address)).to.equal(false);
      expect(await list.isSanctioned(hre.ethers.ZeroAddress)).to.equal(false);
    });
  });

  describe("addToSanctionsList", function () {
    it("flags every address in the array as sanctioned", async function () {
      const { list, owner, alice, bob } = await loadFixture(deployFixture);
      await list.connect(owner).addToSanctionsList([alice.address, bob.address]);
      expect(await list.isSanctioned(alice.address)).to.equal(true);
      expect(await list.isSanctioned(bob.address)).to.equal(true);
    });

    it("emits SanctionedAddressesAdded with the full input array", async function () {
      const { list, owner, alice, bob } = await loadFixture(deployFixture);
      await expect(list.connect(owner).addToSanctionsList([alice.address, bob.address]))
        .to.emit(list, "SanctionedAddressesAdded")
        .withArgs([alice.address, bob.address]);
    });

    it("re-adding an already-sanctioned address is a no-op state-wise", async function () {
      const { list, owner, alice } = await loadFixture(deployFixture);
      await list.connect(owner).addToSanctionsList([alice.address]);
      await list.connect(owner).addToSanctionsList([alice.address]);
      expect(await list.isSanctioned(alice.address)).to.equal(true);
    });

    it("an empty array is allowed (Chainalysis-compatible — no revert)", async function () {
      const { list, owner } = await loadFixture(deployFixture);
      await expect(list.connect(owner).addToSanctionsList([]))
        .to.emit(list, "SanctionedAddressesAdded")
        .withArgs([]);
    });

    it("only the owner may call", async function () {
      const { list, attacker, alice } = await loadFixture(deployFixture);
      await expect(
        list.connect(attacker).addToSanctionsList([alice.address])
      ).to.be.revertedWithCustomError(list, "OwnableUnauthorizedAccount");
    });
  });

  describe("removeFromSanctionsList", function () {
    it("clears the sanction flag for every address in the array", async function () {
      const { list, owner, alice, bob } = await loadFixture(deployFixture);
      await list.connect(owner).addToSanctionsList([alice.address, bob.address]);
      await list.connect(owner).removeFromSanctionsList([alice.address]);
      expect(await list.isSanctioned(alice.address)).to.equal(false);
      expect(await list.isSanctioned(bob.address)).to.equal(true);
    });

    it("emits SanctionedAddressesRemoved with the full input array", async function () {
      const { list, owner, alice, bob } = await loadFixture(deployFixture);
      await list.connect(owner).addToSanctionsList([alice.address, bob.address]);
      await expect(list.connect(owner).removeFromSanctionsList([alice.address, bob.address]))
        .to.emit(list, "SanctionedAddressesRemoved")
        .withArgs([alice.address, bob.address]);
    });

    it("removing a never-added address is allowed (no revert)", async function () {
      const { list, owner, alice } = await loadFixture(deployFixture);
      await expect(list.connect(owner).removeFromSanctionsList([alice.address]))
        .to.emit(list, "SanctionedAddressesRemoved");
      expect(await list.isSanctioned(alice.address)).to.equal(false);
    });

    it("only the owner may call", async function () {
      const { list, owner, attacker, alice } = await loadFixture(deployFixture);
      await list.connect(owner).addToSanctionsList([alice.address]);
      await expect(
        list.connect(attacker).removeFromSanctionsList([alice.address])
      ).to.be.revertedWithCustomError(list, "OwnableUnauthorizedAccount");
    });
  });

  describe("isSanctionedVerbose", function () {
    it("returns true and emits SanctionedAddress for a sanctioned address", async function () {
      const { list, owner, alice } = await loadFixture(deployFixture);
      await list.connect(owner).addToSanctionsList([alice.address]);

      // isSanctionedVerbose is non-view (it emits) — must use a tx, not a static call.
      const tx = await list.isSanctionedVerbose(alice.address);
      await expect(tx).to.emit(list, "SanctionedAddress").withArgs(alice.address);
    });

    it("returns false and emits NonSanctionedAddress for an unflagged address", async function () {
      const { list, alice } = await loadFixture(deployFixture);
      const tx = await list.isSanctionedVerbose(alice.address);
      await expect(tx).to.emit(list, "NonSanctionedAddress").withArgs(alice.address);
    });

    it("anyone can call (not just owner)", async function () {
      const { list, attacker, alice } = await loadFixture(deployFixture);
      await expect(list.connect(attacker).isSanctionedVerbose(alice.address)).to.not.be.reverted;
    });
  });

  describe("ownership transfer (Ownable v5)", function () {
    it("owner can transfer ownership; new owner can manage the list", async function () {
      const { list, owner, alice, bob } = await loadFixture(deployFixture);
      await list.connect(owner).transferOwnership(alice.address);
      expect(await list.owner()).to.equal(alice.address);

      await expect(list.connect(alice).addToSanctionsList([bob.address])).to.not.be.reverted;
      // Old owner can't.
      await expect(
        list.connect(owner).addToSanctionsList([bob.address])
      ).to.be.revertedWithCustomError(list, "OwnableUnauthorizedAccount");
    });

    it("renounceOwnership works — list becomes append-only-by-nobody", async function () {
      const { list, owner, alice } = await loadFixture(deployFixture);
      await list.connect(owner).renounceOwnership();
      expect(await list.owner()).to.equal(hre.ethers.ZeroAddress);
      await expect(
        list.connect(owner).addToSanctionsList([alice.address])
      ).to.be.revertedWithCustomError(list, "OwnableUnauthorizedAccount");
    });
  });

  describe("address normalization", function () {
    it("checksummed and lowercase forms hit the same storage slot", async function () {
      const { list, owner, alice } = await loadFixture(deployFixture);
      const checksummed = hre.ethers.getAddress(alice.address);
      const lowered = checksummed.toLowerCase();

      await list.connect(owner).addToSanctionsList([checksummed]);
      expect(await list.isSanctioned(checksummed)).to.equal(true);
      expect(await list.isSanctioned(lowered)).to.equal(true);
    });
  });
});

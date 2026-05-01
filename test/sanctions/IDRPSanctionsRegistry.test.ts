import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("IDRPSanctionsRegistry — functional", function () {
  const MULTISIG_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MULTISIG_ROLE"));
  const KEEPER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));
  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const CAT_FOREIGN_GOV_LIST = 6;
  const CAT_OJK_DOMESTIC = 7;
  const CAT_CRIMINAL_RANSOMWARE = 3;

  async function deployFixture() {
    const [deployer, multisig, keeper, other, alice, bob] = await hre.ethers.getSigners();

    const Factory = await hre.ethers.getContractFactory("IDRPSanctionsRegistry");
    const registry = await Factory.deploy(multisig.address, keeper.address);
    await registry.waitForDeployment();

    return { registry, deployer, multisig, keeper, other, alice, bob };
  }

  describe("deployment", function () {
    it("grants DEFAULT_ADMIN_ROLE and MULTISIG_ROLE to the multisig and KEEPER_ROLE to the keeper", async function () {
      const { registry, multisig, keeper } = await loadFixture(deployFixture);

      expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, multisig.address)).to.equal(true);
      expect(await registry.hasRole(MULTISIG_ROLE, multisig.address)).to.equal(true);
      expect(await registry.hasRole(KEEPER_ROLE, keeper.address)).to.equal(true);
      expect(await registry.hasRole(KEEPER_ROLE, multisig.address)).to.equal(false);
    });

    it("returns the expected name", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.name()).to.equal("IDRP Sanctions Registry v1");
    });

    it("starts with sanctionedCount = 0 and reads false for any address", async function () {
      const { registry, alice } = await loadFixture(deployFixture);
      expect(await registry.sanctionedCount()).to.equal(0);
      expect(await registry.isSanctioned(alice.address)).to.equal(false);
    });

    it("exposes the documented category constants", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.CAT_UNCATEGORIZED()).to.equal(0);
      expect(await registry.CAT_UN_DESIGNATED()).to.equal(1);
      expect(await registry.CAT_LAW_ENFORCEMENT()).to.equal(2);
      expect(await registry.CAT_CRIMINAL_RANSOMWARE()).to.equal(3);
      expect(await registry.CAT_CRIMINAL_SCAM_THEFT()).to.equal(4);
      expect(await registry.CAT_CRIMINAL_DARKNET()).to.equal(5);
      expect(await registry.CAT_FOREIGN_GOV_LIST()).to.equal(6);
      expect(await registry.CAT_OJK_DOMESTIC()).to.equal(7);
      expect(await registry.CAT_OFAC_SDN()).to.equal(8);
      expect(await registry.MAX_BATCH_SIZE()).to.equal(500);
    });
  });

  describe("single ops (multisig only)", function () {
    it("adds, increments count, and emits both Chainalysis-compatible and extended events", async function () {
      const { registry, multisig, alice } = await loadFixture(deployFixture);

      const tx = registry.connect(multisig).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "OpenSanctions:NBCTF");
      await expect(tx).to.emit(registry, "SanctionedAddress").withArgs(alice.address);
      await expect(tx).to.emit(registry, "SanctionedAddressAdded");

      expect(await registry.isSanctioned(alice.address)).to.equal(true);
      expect(await registry.sanctionedCount()).to.equal(1);

      const [sanctioned, category, source] = await registry.isSanctionedVerbose(alice.address);
      expect(sanctioned).to.equal(true);
      expect(category).to.equal(CAT_FOREIGN_GOV_LIST);
      expect(source).to.equal("OpenSanctions:NBCTF");

      const entry = await registry.getEntry(alice.address);
      expect(entry.isSanctioned).to.equal(true);
      expect(entry.category).to.equal(CAT_FOREIGN_GOV_LIST);
      expect(entry.source).to.equal("OpenSanctions:NBCTF");
      expect(entry.addedAt).to.be.gt(0n);
    });

    it("removes and emits both event flavors", async function () {
      const { registry, multisig, alice } = await loadFixture(deployFixture);
      await registry.connect(multisig).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "src");

      const tx = registry.connect(multisig).removeSanctioned(alice.address);
      await expect(tx).to.emit(registry, "NonSanctionedAddress").withArgs(alice.address);
      await expect(tx).to.emit(registry, "SanctionedAddressRemoved").withArgs(alice.address);

      expect(await registry.isSanctioned(alice.address)).to.equal(false);
      expect(await registry.sanctionedCount()).to.equal(0);

      const entry = await registry.getEntry(alice.address);
      expect(entry.isSanctioned).to.equal(false);
      expect(entry.category).to.equal(0);
      expect(entry.source).to.equal("");
    });

    it("re-adding an already-sanctioned address keeps count at 1 and updates metadata", async function () {
      const { registry, multisig, alice } = await loadFixture(deployFixture);
      await registry.connect(multisig).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "first");
      await registry.connect(multisig).addSanctioned(alice.address, CAT_OJK_DOMESTIC, "second");

      expect(await registry.sanctionedCount()).to.equal(1);
      const entry = await registry.getEntry(alice.address);
      expect(entry.category).to.equal(CAT_OJK_DOMESTIC);
      expect(entry.source).to.equal("second");
    });

    it("re-adding does NOT re-emit the Chainalysis SanctionedAddress event", async function () {
      const { registry, multisig, alice } = await loadFixture(deployFixture);
      await registry.connect(multisig).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "first");

      const tx = registry.connect(multisig).addSanctioned(alice.address, CAT_OJK_DOMESTIC, "second");
      await expect(tx).to.not.emit(registry, "SanctionedAddress");
      await expect(tx).to.emit(registry, "SanctionedAddressAdded");
    });

    it("removing a non-sanctioned address is a no-op (no events, count unchanged)", async function () {
      const { registry, multisig, alice } = await loadFixture(deployFixture);

      const tx = registry.connect(multisig).removeSanctioned(alice.address);
      await expect(tx).to.not.emit(registry, "NonSanctionedAddress");
      await expect(tx).to.not.emit(registry, "SanctionedAddressRemoved");
      expect(await registry.sanctionedCount()).to.equal(0);
    });

    it("rejects single-add from non-multisig", async function () {
      const { registry, keeper, other, alice } = await loadFixture(deployFixture);
      await expect(
        registry.connect(keeper).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "x")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(
        registry.connect(other).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "x")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects single-remove from non-multisig", async function () {
      const { registry, multisig, keeper, alice } = await loadFixture(deployFixture);
      await registry.connect(multisig).addSanctioned(alice.address, CAT_FOREIGN_GOV_LIST, "x");
      await expect(
        registry.connect(keeper).removeSanctioned(alice.address)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("batch ops (keeper)", function () {
    it("adds a batch, increments count by unique-new count, emits per-entry events for new entries plus a BatchAdded summary", async function () {
      const { registry, keeper, alice, bob } = await loadFixture(deployFixture);

      const addrs = [alice.address, bob.address];
      const tx = registry.connect(keeper).batchAddSanctioned(addrs, CAT_CRIMINAL_RANSOMWARE, "ransomwhe.re");
      await expect(tx).to.emit(registry, "SanctionedAddress").withArgs(alice.address);
      await expect(tx).to.emit(registry, "SanctionedAddress").withArgs(bob.address);
      await expect(tx).to.emit(registry, "BatchAdded").withArgs(2, CAT_CRIMINAL_RANSOMWARE, "ransomwhe.re");

      expect(await registry.sanctionedCount()).to.equal(2);
      expect(await registry.isSanctioned(alice.address)).to.equal(true);
      expect(await registry.isSanctioned(bob.address)).to.equal(true);
    });

    it("a batch with duplicate entries inside it does not double-count", async function () {
      const { registry, keeper, alice } = await loadFixture(deployFixture);
      await registry
        .connect(keeper)
        .batchAddSanctioned([alice.address, alice.address, alice.address], CAT_FOREIGN_GOV_LIST, "src");

      expect(await registry.sanctionedCount()).to.equal(1);
    });

    it("a batch with already-listed entries does not increase count and does not re-emit Chainalysis SanctionedAddress for those", async function () {
      const { registry, keeper, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(keeper).batchAddSanctioned([alice.address], CAT_FOREIGN_GOV_LIST, "first");

      const tx = registry.connect(keeper).batchAddSanctioned([alice.address, bob.address], CAT_OJK_DOMESTIC, "second");
      // bob is new — emits Chainalysis-compatible
      await expect(tx).to.emit(registry, "SanctionedAddress").withArgs(bob.address);
      // both emit the extended event regardless
      await expect(tx).to.emit(registry, "SanctionedAddressAdded");

      expect(await registry.sanctionedCount()).to.equal(2);
    });

    it("removes a batch and emits BatchRemoved with the actually-removed count (not the input length)", async function () {
      const { registry, keeper, alice, bob, other } = await loadFixture(deployFixture);
      await registry.connect(keeper).batchAddSanctioned([alice.address, bob.address], CAT_FOREIGN_GOV_LIST, "src");

      // input includes one address that was never added (other) — should be skipped
      const tx = registry
        .connect(keeper)
        .batchRemoveSanctioned([alice.address, bob.address, other.address]);
      await expect(tx).to.emit(registry, "BatchRemoved").withArgs(2);

      expect(await registry.sanctionedCount()).to.equal(0);
    });

    it("rejects empty batch", async function () {
      const { registry, keeper } = await loadFixture(deployFixture);
      await expect(
        registry.connect(keeper).batchAddSanctioned([], CAT_FOREIGN_GOV_LIST, "src")
      ).to.be.revertedWithCustomError(registry, "EmptyBatch");
      await expect(registry.connect(keeper).batchRemoveSanctioned([])).to.be.revertedWithCustomError(
        registry,
        "EmptyBatch"
      );
    });

    it("rejects batch larger than MAX_BATCH_SIZE", async function () {
      const { registry, keeper } = await loadFixture(deployFixture);
      const tooBig = makeAddrs(1, 501);
      await expect(
        registry.connect(keeper).batchAddSanctioned(tooBig, CAT_FOREIGN_GOV_LIST, "src")
      )
        .to.be.revertedWithCustomError(registry, "BatchTooLarge")
        .withArgs(501, 500);
    });

    it("rejects batch from non-keeper (including the multisig)", async function () {
      const { registry, multisig, other, alice } = await loadFixture(deployFixture);
      await expect(
        registry.connect(multisig).batchAddSanctioned([alice.address], CAT_FOREIGN_GOV_LIST, "src")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(
        registry.connect(other).batchAddSanctioned([alice.address], CAT_FOREIGN_GOV_LIST, "src")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("role administration", function () {
    it("multisig (DEFAULT_ADMIN) can grant KEEPER_ROLE to a new address", async function () {
      const { registry, multisig, other, alice } = await loadFixture(deployFixture);

      await registry.connect(multisig).grantRole(KEEPER_ROLE, other.address);
      await expect(
        registry.connect(other).batchAddSanctioned([alice.address], CAT_FOREIGN_GOV_LIST, "src")
      ).to.not.be.reverted;
    });

    it("multisig can revoke KEEPER_ROLE; the revoked address can no longer batch-add", async function () {
      const { registry, multisig, keeper, alice } = await loadFixture(deployFixture);

      await registry.connect(multisig).revokeRole(KEEPER_ROLE, keeper.address);
      await expect(
        registry.connect(keeper).batchAddSanctioned([alice.address], CAT_FOREIGN_GOV_LIST, "src")
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("non-admin cannot grant roles", async function () {
      const { registry, keeper, other } = await loadFixture(deployFixture);
      await expect(
        registry.connect(keeper).grantRole(KEEPER_ROLE, other.address)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("category handling", function () {
    it("accepts arbitrary uint8 category codes (no on-chain validation by design)", async function () {
      const { registry, keeper, alice } = await loadFixture(deployFixture);
      await registry.connect(keeper).batchAddSanctioned([alice.address], 99, "future-extension");
      const entry = await registry.getEntry(alice.address);
      expect(entry.category).to.equal(99);
    });

    it("category survives across re-add updates", async function () {
      const { registry, keeper, alice } = await loadFixture(deployFixture);
      await registry.connect(keeper).batchAddSanctioned([alice.address], CAT_CRIMINAL_RANSOMWARE, "ransomwhe.re");
      await registry.connect(keeper).batchAddSanctioned([alice.address], CAT_OJK_DOMESTIC, "OJK");
      const entry = await registry.getEntry(alice.address);
      expect(entry.category).to.equal(CAT_OJK_DOMESTIC);
      expect(entry.source).to.equal("OJK");
    });
  });

  describe("address normalization", function () {
    it("treats checksummed and lowercase addresses identically", async function () {
      const { registry, keeper, alice } = await loadFixture(deployFixture);
      const checksummed = hre.ethers.getAddress(alice.address);
      const lowered = checksummed.toLowerCase();

      await registry.connect(keeper).batchAddSanctioned([checksummed], CAT_FOREIGN_GOV_LIST, "src");

      // Both forms hit the same mapping slot — Solidity address ABI ignores case.
      expect(await registry.isSanctioned(checksummed)).to.equal(true);
      expect(await registry.isSanctioned(lowered)).to.equal(true);
    });
  });
});

// Deterministic counter-based address generator. Mirrors the gas test helper
// so the two suites share a stable address space.
function makeAddrs(start: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(hre.ethers.getAddress("0x" + (start + i).toString(16).padStart(40, "0")));
  }
  return out;
}

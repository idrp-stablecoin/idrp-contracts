import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [C-1] IDRP upgrade flow.
 *
 * Covers all three in-scope audit fixes on IDRP:
 *   (1) single-address `upgrader` replaces legacy UPGRADER_ROLE
 *   (2) 48h timelock on upgrade execution (mirrors IDRPController)
 *   (3) UpgradeScheduled / UpgradeCancelled events for OJK audit trail
 *
 * Item (4) — routing upgrade through executeOperation — intentionally skipped
 * per senior direction; Safe multi-sig is sufficient at the wallet layer.
 */
describe("[C-1] IDRP upgrade flow (single upgrader + timelock)", function () {
  const UPGRADER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("UPGRADER_ROLE")
  );
  const UPGRADE_DELAY = 48 * 60 * 60; // 48 hours in seconds

  async function deployFixture() {
    const [superAdmin, newUpgrader, other, legacyA, legacyB] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [
      superAdmin.address,
    ]);
    await idrp.waitForDeployment();

    // Prepare a new implementation address we can schedule/execute against.
    const newImplAddr = (await hre.upgrades.prepareUpgrade(
      await idrp.getAddress(),
      IDRPFactory
    )) as string;

    return {
      idrp,
      IDRPFactory,
      newImplAddr,
      superAdmin,
      newUpgrader,
      other,
      legacyA,
      legacyB,
    };
  }

  describe("initialize", function () {
    it("Should set upgrader = superAdmin on fresh deploy", async function () {
      const { idrp, superAdmin } = await loadFixture(deployFixture);
      expect(await idrp.upgrader()).to.equal(superAdmin.address);
    });

    it("Should not grant legacy UPGRADER_ROLE to superAdmin on fresh deploy", async function () {
      const { idrp, superAdmin } = await loadFixture(deployFixture);
      expect(await idrp.hasRole(UPGRADER_ROLE, superAdmin.address)).to.be.false;
    });

    it("Should initialize timelock state empty", async function () {
      const { idrp } = await loadFixture(deployFixture);
      expect(await idrp.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await idrp.upgradeScheduledAt()).to.equal(0);
      expect(await idrp.UPGRADE_DELAY()).to.equal(UPGRADE_DELAY);
    });
  });

  describe("setUpgrader", function () {
    it("Should rotate upgrader and emit UpgraderUpdated", async function () {
      const { idrp, superAdmin, newUpgrader } = await loadFixture(deployFixture);

      await expect(idrp.connect(superAdmin).setUpgrader(newUpgrader.address))
        .to.emit(idrp, "UpgraderUpdated")
        .withArgs(superAdmin.address, newUpgrader.address);

      expect(await idrp.upgrader()).to.equal(newUpgrader.address);
    });

    it("Should revert if caller is not DEFAULT_ADMIN_ROLE", async function () {
      const { idrp, other, newUpgrader } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(other).setUpgrader(newUpgrader.address)
      ).to.be.rejected;
    });

    it("Should reject address(0)", async function () {
      const { idrp, superAdmin } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(superAdmin).setUpgrader(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid upgrader");
    });
  });

  describe("scheduleUpgrade", function () {
    it("Should schedule an upgrade with correct event and state", async function () {
      const { idrp, newImplAddr, superAdmin } = await loadFixture(deployFixture);

      const tx = await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);
      const block = await hre.ethers.provider.getBlock(tx.blockNumber!);

      await expect(tx)
        .to.emit(idrp, "UpgradeScheduled")
        .withArgs(newImplAddr, block!.timestamp + UPGRADE_DELAY);

      expect(await idrp.scheduledImplementation()).to.equal(newImplAddr);
      expect(await idrp.upgradeScheduledAt()).to.equal(block!.timestamp);
    });

    it("Should revert if newImplementation is address(0)", async function () {
      const { idrp, superAdmin } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(superAdmin).scheduleUpgrade(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid implementation address");
    });

    it("Should revert if caller is not the upgrader (NotUpgrader)", async function () {
      const { idrp, newImplAddr, other } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(other).scheduleUpgrade(newImplAddr)
      ).to.be.revertedWithCustomError(idrp, "NotUpgrader");
    });
  });

  describe("cancelUpgrade", function () {
    it("Should cancel a scheduled upgrade and emit UpgradeCancelled", async function () {
      const { idrp, newImplAddr, superAdmin } = await loadFixture(deployFixture);

      await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);

      const tx = await idrp.connect(superAdmin).cancelUpgrade();
      await expect(tx)
        .to.emit(idrp, "UpgradeCancelled")
        .withArgs(newImplAddr, superAdmin.address);

      expect(await idrp.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await idrp.upgradeScheduledAt()).to.equal(0);
    });

    it("Should revert if no pending upgrade", async function () {
      const { idrp, superAdmin } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(superAdmin).cancelUpgrade()
      ).to.be.revertedWith("No pending upgrade");
    });

    it("Should revert if caller is not the upgrader (NotUpgrader)", async function () {
      const { idrp, newImplAddr, superAdmin, other } =
        await loadFixture(deployFixture);

      await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);
      await expect(
        idrp.connect(other).cancelUpgrade()
      ).to.be.revertedWithCustomError(idrp, "NotUpgrader");
    });
  });

  describe("_authorizeUpgrade (via upgradeToAndCall)", function () {
    it("Should revert with NotUpgrader when caller is not upgrader", async function () {
      const { idrp, newImplAddr, superAdmin, newUpgrader } =
        await loadFixture(deployFixture);

      // Rotate upgrader away from superAdmin, but schedule must come from upgrader too.
      await idrp.connect(superAdmin).setUpgrader(newUpgrader.address);
      await idrp.connect(newUpgrader).scheduleUpgrade(newImplAddr);
      await time.increase(UPGRADE_DELAY + 1);

      await expect(
        idrp.connect(superAdmin).upgradeToAndCall(newImplAddr, "0x")
      ).to.be.revertedWithCustomError(idrp, "NotUpgrader");
    });

    it("Should revert if upgrade is not scheduled", async function () {
      const { idrp, newImplAddr, superAdmin } = await loadFixture(deployFixture);
      await expect(
        idrp.connect(superAdmin).upgradeToAndCall(newImplAddr, "0x")
      ).to.be.revertedWith("Upgrade not scheduled");
    });

    it("Should revert if timelock has not expired", async function () {
      const { idrp, newImplAddr, superAdmin } = await loadFixture(deployFixture);

      await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);

      await expect(
        idrp.connect(superAdmin).upgradeToAndCall(newImplAddr, "0x")
      ).to.be.revertedWith("Timelock not expired");
    });

    it("Should succeed after timelock expires and clear scheduled state", async function () {
      const { idrp, newImplAddr, superAdmin } = await loadFixture(deployFixture);

      await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);
      await time.increase(UPGRADE_DELAY + 1);

      await expect(
        idrp.connect(superAdmin).upgradeToAndCall(newImplAddr, "0x")
      ).to.not.be.reverted;

      expect(await idrp.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await idrp.upgradeScheduledAt()).to.equal(0);
    });

    it("Should revert if wrong implementation is executed", async function () {
      const { idrp, IDRPFactory, newImplAddr, superAdmin } =
        await loadFixture(deployFixture);

      await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);
      await time.increase(UPGRADE_DELAY + 1);

      // Deploy a different implementation and try to execute that instead
      const anotherImpl = await IDRPFactory.deploy();
      await anotherImpl.waitForDeployment();

      await expect(
        idrp
          .connect(superAdmin)
          .upgradeToAndCall(await anotherImpl.getAddress(), "0x")
      ).to.be.revertedWith("Upgrade not scheduled");
    });

    it("Should revert if upgrade was cancelled then re-attempted", async function () {
      const { idrp, newImplAddr, superAdmin } = await loadFixture(deployFixture);

      await idrp.connect(superAdmin).scheduleUpgrade(newImplAddr);
      await idrp.connect(superAdmin).cancelUpgrade();
      await time.increase(UPGRADE_DELAY + 1);

      await expect(
        idrp.connect(superAdmin).upgradeToAndCall(newImplAddr, "0x")
      ).to.be.revertedWith("Upgrade not scheduled");
    });

    it("Should succeed after rotation: new upgrader schedules and executes", async function () {
      const { idrp, newImplAddr, superAdmin, newUpgrader } =
        await loadFixture(deployFixture);

      await idrp.connect(superAdmin).setUpgrader(newUpgrader.address);
      await idrp.connect(newUpgrader).scheduleUpgrade(newImplAddr);
      await time.increase(UPGRADE_DELAY + 1);

      await expect(
        idrp.connect(newUpgrader).upgradeToAndCall(newImplAddr, "0x")
      ).to.not.be.reverted;
    });
  });

  describe("initializeV2 migration (simulated v1 → v2)", function () {
    /**
     * Simulate a v1 proxy's storage preconditions (legacy UPGRADER_ROLE grants
     * populated, Initializable counter reset to 1), then run initializeV2 and
     * assert the migration sets the new upgrader and revokes every listed
     * historical grantee. The timelock state is NOT initialized by initializeV2
     * — default zeroes already mean "no pending upgrade", which is correct.
     */
    async function v1SimulatedFixture() {
      const base = await deployFixture();
      const { idrp, superAdmin, legacyA, legacyB } = base;

      await idrp
        .connect(superAdmin)
        .grantRole(UPGRADER_ROLE, superAdmin.address);
      await idrp.connect(superAdmin).grantRole(UPGRADER_ROLE, legacyA.address);
      await idrp.connect(superAdmin).grantRole(UPGRADER_ROLE, legacyB.address);

      // Reset Initializable._initialized so reinitializer(2) can fire.
      // Slot derived from ERC-7201 namespace "openzeppelin.storage.Initializable".
      const initSlot =
        "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
      await hre.network.provider.send("hardhat_setStorageAt", [
        await idrp.getAddress(),
        initSlot,
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ]);

      return base;
    }

    it("Should set new upgrader and emit UpgraderUpdated", async function () {
      const { idrp, superAdmin, newUpgrader, legacyA, legacyB } =
        await loadFixture(v1SimulatedFixture);

      await expect(
        idrp
          .connect(superAdmin)
          .initializeV2(newUpgrader.address, [
            superAdmin.address,
            legacyA.address,
            legacyB.address,
          ])
      )
        .to.emit(idrp, "UpgraderUpdated")
        .withArgs(superAdmin.address, newUpgrader.address);

      expect(await idrp.upgrader()).to.equal(newUpgrader.address);
    });

    it("Should revoke legacy UPGRADER_ROLE from every listed holder", async function () {
      const { idrp, superAdmin, newUpgrader, legacyA, legacyB } =
        await loadFixture(v1SimulatedFixture);

      expect(await idrp.hasRole(UPGRADER_ROLE, superAdmin.address)).to.be.true;
      expect(await idrp.hasRole(UPGRADER_ROLE, legacyA.address)).to.be.true;
      expect(await idrp.hasRole(UPGRADER_ROLE, legacyB.address)).to.be.true;

      await idrp
        .connect(superAdmin)
        .initializeV2(newUpgrader.address, [
          superAdmin.address,
          legacyA.address,
          legacyB.address,
        ]);

      expect(await idrp.hasRole(UPGRADER_ROLE, superAdmin.address)).to.be.false;
      expect(await idrp.hasRole(UPGRADER_ROLE, legacyA.address)).to.be.false;
      expect(await idrp.hasRole(UPGRADER_ROLE, legacyB.address)).to.be.false;
    });

    it("Should leave timelock state zeroed (no pending upgrade) after migration", async function () {
      const { idrp, superAdmin, newUpgrader } = await loadFixture(
        v1SimulatedFixture
      );

      await idrp
        .connect(superAdmin)
        .initializeV2(newUpgrader.address, [superAdmin.address]);

      expect(await idrp.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await idrp.upgradeScheduledAt()).to.equal(0);
    });

    it("Should revert if _upgrader is address(0)", async function () {
      const { idrp, superAdmin } = await loadFixture(v1SimulatedFixture);
      await expect(
        idrp.connect(superAdmin).initializeV2(hre.ethers.ZeroAddress, [])
      ).to.be.revertedWith("Invalid upgrader");
    });

    it("Should not be callable twice (reinitializer(2) protection)", async function () {
      const { idrp, superAdmin, newUpgrader } = await loadFixture(
        v1SimulatedFixture
      );

      await idrp
        .connect(superAdmin)
        .initializeV2(newUpgrader.address, [superAdmin.address]);

      await expect(
        idrp.connect(superAdmin).initializeV2(newUpgrader.address, [])
      ).to.be.rejected;
    });
  });
});

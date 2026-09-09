import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

// OZ 4.9.6 note: `upgradeToAndCall(impl, "0x")` ALWAYS reverts on this lineage —
// it passes forceCall=true, so it delegatecalls the implementation with empty
// calldata and hits a fallback that does not exist. `upgradeTo(impl)` is the
// correct call for a no-data upgrade here. OZ 5 skips the call when data is
// empty, which is why the EVM branch's scripts can use upgradeToAndCall.

describe("[C-1] Upgrade Without Multisig/Timelock", function () {
  async function deployFixture() {
    const [owner, other] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [owner.address]);
    await idrp.waitForDeployment();

    const ControllerFactory =
      await hre.ethers.getContractFactory("IDRPController");
    const controller = await hre.upgrades.deployProxy(ControllerFactory, [
      await idrp.getAddress(),
      owner.address,
    ]);
    await controller.waitForDeployment();

    // Prepare a new implementation (get address without upgrading)
    const newImplAddr = (await hre.upgrades.prepareUpgrade(
      await controller.getAddress(),
      ControllerFactory
    )) as string;

    const UPGRADE_DELAY = 48 * 60 * 60; // 48 hours in seconds

    return {
      controller,
      ControllerFactory,
      newImplAddr,
      owner,
      other,
      UPGRADE_DELAY,
    };
  }

  describe("scheduleUpgrade", function () {
    it("Should schedule an upgrade with correct event", async function () {
      const { controller, newImplAddr, owner, UPGRADE_DELAY } =
        await loadFixture(deployFixture);

      const tx = await controller.connect(owner).scheduleUpgrade(newImplAddr);
      const block = await hre.ethers.provider.getBlock(tx.blockNumber!);

      await expect(tx)
        .to.emit(controller, "UpgradeScheduled")
        .withArgs(newImplAddr, block!.timestamp + UPGRADE_DELAY);

      expect(await controller.scheduledImplementation()).to.equal(newImplAddr);
      expect(await controller.upgradeScheduledAt()).to.equal(block!.timestamp);
    });

    it("Should revert if newImplementation is address(0)", async function () {
      const { controller, owner } = await loadFixture(deployFixture);

      await expect(
        controller.connect(owner).scheduleUpgrade(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid implementation address");
    });

    it("Should revert if caller is not owner", async function () {
      const { controller, newImplAddr, other } =
        await loadFixture(deployFixture);

      await expect(
        controller.connect(other).scheduleUpgrade(newImplAddr)
      ).to.be.reverted;
    });
  });

  describe("cancelUpgrade", function () {
    it("Should cancel a scheduled upgrade", async function () {
      const { controller, newImplAddr, owner } =
        await loadFixture(deployFixture);

      await controller.connect(owner).scheduleUpgrade(newImplAddr);

      const tx = await controller.connect(owner).cancelUpgrade();

      await expect(tx)
        .to.emit(controller, "UpgradeCancelled")
        .withArgs(newImplAddr, owner.address);

      expect(await controller.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await controller.upgradeScheduledAt()).to.equal(0);
    });

    it("Should revert if no pending upgrade", async function () {
      const { controller, owner } = await loadFixture(deployFixture);

      await expect(
        controller.connect(owner).cancelUpgrade()
      ).to.be.revertedWith("No pending upgrade");
    });

    it("Should revert if caller is not owner", async function () {
      const { controller, newImplAddr, owner, other } =
        await loadFixture(deployFixture);

      await controller.connect(owner).scheduleUpgrade(newImplAddr);

      await expect(controller.connect(other).cancelUpgrade()).to.be.reverted;
    });
  });

  describe("_authorizeUpgrade (via upgradeToAndCall)", function () {
    it("Should revert if upgrade is not scheduled", async function () {
      const { controller, newImplAddr, owner } =
        await loadFixture(deployFixture);

      // Try to upgrade without scheduling
      const proxy = await hre.ethers.getContractAt(
        "IDRPController",
        await controller.getAddress()
      );
      await expect(
        proxy.connect(owner).upgradeTo(newImplAddr)
      ).to.be.revertedWith("Upgrade not scheduled");
    });

    it("Should revert if timelock has not expired", async function () {
      const { controller, newImplAddr, owner } =
        await loadFixture(deployFixture);

      // Schedule
      await controller.connect(owner).scheduleUpgrade(newImplAddr);

      // Try to upgrade immediately (before 48h)
      const proxy = await hre.ethers.getContractAt(
        "IDRPController",
        await controller.getAddress()
      );
      await expect(
        proxy.connect(owner).upgradeTo(newImplAddr)
      ).to.be.revertedWith("Timelock not expired");
    });

    it("Should succeed after timelock expires", async function () {
      const { controller, newImplAddr, owner, UPGRADE_DELAY } =
        await loadFixture(deployFixture);

      // Schedule
      await controller.connect(owner).scheduleUpgrade(newImplAddr);

      // Advance time past 48h
      await time.increase(UPGRADE_DELAY + 1);

      // Upgrade should succeed
      const proxy = await hre.ethers.getContractAt(
        "IDRPController",
        await controller.getAddress()
      );
      await expect(proxy.connect(owner).upgradeTo(newImplAddr)).to
        .not.be.reverted;

      // State should be reset
      expect(await controller.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await controller.upgradeScheduledAt()).to.equal(0);
    });

    it("Should revert if upgrade cancelled then attempted", async function () {
      const { controller, newImplAddr, owner, UPGRADE_DELAY } =
        await loadFixture(deployFixture);

      // Schedule
      await controller.connect(owner).scheduleUpgrade(newImplAddr);

      // Cancel
      await controller.connect(owner).cancelUpgrade();

      // Advance time past 48h
      await time.increase(UPGRADE_DELAY + 1);

      // Should revert — upgrade was cancelled
      const proxy = await hre.ethers.getContractAt(
        "IDRPController",
        await controller.getAddress()
      );
      await expect(
        proxy.connect(owner).upgradeTo(newImplAddr)
      ).to.be.revertedWith("Upgrade not scheduled");
    });

    it("Should revert if wrong implementation address", async function () {
      const { controller, newImplAddr, owner, UPGRADE_DELAY } =
        await loadFixture(deployFixture);

      // Schedule with one address
      await controller.connect(owner).scheduleUpgrade(newImplAddr);

      // Advance time past 48h
      await time.increase(UPGRADE_DELAY + 1);

      // Try to upgrade with a different implementation
      const AnotherFactory =
        await hre.ethers.getContractFactory("IDRPController");
      const anotherImpl = await AnotherFactory.deploy();
      await anotherImpl.waitForDeployment();

      const proxy = await hre.ethers.getContractAt(
        "IDRPController",
        await controller.getAddress()
      );
      await expect(
        proxy
          .connect(owner)
          .upgradeToAndCall(await anotherImpl.getAddress(), "0x")
      ).to.be.revertedWith("Upgrade not scheduled");
    });
  });
});

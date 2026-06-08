import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [V4-1] Audit v4.0 finding: initializeV2() frontrunning risk.
 *
 * Pre-fix: initializeV2() on IDRP.sol had only `reinitializer(2)` — anyone
 * could front-run the post-upgrade migration tx and seize `upgrader`.
 *
 * Fix: gate with `onlyRole(DEFAULT_ADMIN_ROLE)`. Tests below pin both halves
 * of the contract: only the admin can run the migration, and the original
 * reinitializer-once protection still holds.
 */
describe("[0426 MINOR-1] IDRP.initializeV2 access control", function () {
  const UPGRADER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("UPGRADER_ROLE")
  );

  // Slot derived from ERC-7201 namespace "openzeppelin.storage.Initializable".
  // Resetting it to 1 lets us call reinitializer(2) on a freshly-deployed v1
  // proxy without going through a real upgrade (cheaper, deterministic).
  const INITIALIZABLE_SLOT =
    "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

  async function v1SimulatedFixture() {
    const [superAdmin, attacker, newUpgrader, legacyA, legacyB] =
      await hre.ethers.getSigners();

    // The v1→v2 migration (with the DEFAULT_ADMIN_ROLE access-control gate)
    // lives in legacy/IDRPv2.sol since v3 dropped AccessControlUpgradeable.
    // Pin the audit fix against the legacy contract — that's what testnets
    // still on v1 will deploy via scripts/v1-to-v2/.
    const LegacyV2Factory = await hre.ethers.getContractFactory("IDRPv2");
    const idrp = await hre.upgrades.deployProxy(LegacyV2Factory, [
      superAdmin.address,
    ]);
    await idrp.waitForDeployment();

    // Simulate legacy state: historical UPGRADER_ROLE grants present.
    await idrp.connect(superAdmin).grantRole(UPGRADER_ROLE, legacyA.address);
    await idrp.connect(superAdmin).grantRole(UPGRADER_ROLE, legacyB.address);

    // Reset Initializable so reinitializer(2) can fire.
    await hre.network.provider.send("hardhat_setStorageAt", [
      await idrp.getAddress(),
      INITIALIZABLE_SLOT,
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);

    return { idrp, superAdmin, attacker, newUpgrader, legacyA, legacyB };
  }

  it("Should revert when caller is not DEFAULT_ADMIN_ROLE (frontrunner blocked)", async function () {
    const { idrp, attacker, newUpgrader } = await loadFixture(
      v1SimulatedFixture
    );

    // The exact attack from the audit: an attacker tries to front-run the
    // legitimate post-upgrade migration tx with their own _upgrader value.
    await expect(
      idrp.connect(attacker).initializeV2(newUpgrader.address, [])
    ).to.be.revertedWithCustomError(
      idrp,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("Should succeed when called by DEFAULT_ADMIN_ROLE", async function () {
    const { idrp, superAdmin, newUpgrader, legacyA, legacyB } =
      await loadFixture(v1SimulatedFixture);

    await expect(
      idrp
        .connect(superAdmin)
        .initializeV2(newUpgrader.address, [
          legacyA.address,
          legacyB.address,
        ])
    )
      .to.emit(idrp, "UpgraderUpdated")
      .withArgs(superAdmin.address, newUpgrader.address);

    expect(await idrp.upgrader()).to.equal(newUpgrader.address);
    expect(await idrp.hasRole(UPGRADER_ROLE, legacyA.address)).to.be.false;
    expect(await idrp.hasRole(UPGRADER_ROLE, legacyB.address)).to.be.false;
  });

  it("Should still enforce reinitializer(2) — second call by admin reverts", async function () {
    const { idrp, superAdmin, newUpgrader } = await loadFixture(
      v1SimulatedFixture
    );

    await idrp
      .connect(superAdmin)
      .initializeV2(newUpgrader.address, []);

    await expect(
      idrp.connect(superAdmin).initializeV2(newUpgrader.address, [])
    ).to.be.revertedWithCustomError(idrp, "InvalidInitialization");
  });

  it("Should revert if attacker calls AFTER admin has already migrated", async function () {
    // Belt-and-braces: even if the role check were ever lifted, reinitializer(2)
    // means the slot is consumed. This test pins the layered defence.
    const { idrp, superAdmin, attacker, newUpgrader } = await loadFixture(
      v1SimulatedFixture
    );

    await idrp.connect(superAdmin).initializeV2(newUpgrader.address, []);

    await expect(
      idrp.connect(attacker).initializeV2(attacker.address, [])
    ).to.be.reverted;
  });
});

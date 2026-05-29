import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [V4-2] Audit v4.0 finding: IDRPController upgrade auth was OwnableUpgradeable.
 *
 * Pre-fix: scheduleUpgrade / cancelUpgrade / _authorizeUpgrade / withdrawToken
 *          all used `onlyOwner`. If owner had ever been deployed as an EOA
 *          (not a Safe), one private key compromise = one malicious upgrade.
 *
 * Fix: drop OwnableUpgradeable entirely; mirror IDRP.sol — `address upgrader`
 *      rotatable by DEFAULT_ADMIN_ROLE, gated by `onlyUpgrader` modifier;
 *      withdrawToken moved under DEFAULT_ADMIN_ROLE.
 *
 * The high-stakes part is upgrade compatibility: OwnableUpgradeable lived in
 * an ERC-7201 namespace in OZ v5, so its `_owner` slot does not collide with
 * any sequential storage slot. This file pins that contract upgrades v1 → v2
 * preserve every state variable.
 */
describe("[V4-2] IDRPController — Ownable removal + upgrader pattern", function () {
  const ADMIN_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("ADMIN_ROLE")
  );
  const UPGRADE_DELAY = 48 * 60 * 60;

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fresh-deploy fixture (production code path)
  // ─────────────────────────────────────────────────────────────────────────
  async function freshDeployFixture() {
    const [admin, attacker, newUpgrader, recipient] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    const ControllerFactory = await hre.ethers.getContractFactory(
      "IDRPController"
    );
    const controller = await hre.upgrades.deployProxy(ControllerFactory, [
      await idrp.getAddress(),
      admin.address,
    ]);
    await controller.waitForDeployment();

    // Pre-stage a candidate next implementation so we can test the timelock.
    const newImplAddr = (await hre.upgrades.prepareUpgrade(
      await controller.getAddress(),
      ControllerFactory
    )) as string;

    return {
      idrp,
      controller,
      ControllerFactory,
      newImplAddr,
      admin,
      attacker,
      newUpgrader,
      recipient,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Deploy section
  // ─────────────────────────────────────────────────────────────────────────
  describe("initialize", function () {
    it("Should set upgrader = _safeAddress on fresh deploy", async function () {
      const { controller, admin } = await loadFixture(freshDeployFixture);
      expect(await controller.upgrader()).to.equal(admin.address);
    });

    it("Should emit UpgraderUpdated(0, safe) on initialize", async function () {
      const [admin] = await hre.ethers.getSigners();

      const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
      const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
      await idrp.waitForDeployment();

      const ControllerFactory = await hre.ethers.getContractFactory(
        "IDRPController"
      );
      const controller = await hre.upgrades.deployProxy(ControllerFactory, [
        await idrp.getAddress(),
        admin.address,
      ]);
      await controller.waitForDeployment();

      // The proxy emits initialize-time events too; read via filter rather
      // than .to.emit on a non-tx receipt.
      const events = await controller.queryFilter(
        controller.filters.UpgraderUpdated()
      );
      expect(events.length).to.equal(1);
      expect(events[0].args[0]).to.equal(hre.ethers.ZeroAddress);
      expect(events[0].args[1]).to.equal(admin.address);
    });

    it("Should grant DEFAULT_ADMIN_ROLE and ADMIN_ROLE to safe address", async function () {
      const { controller, admin } = await loadFixture(freshDeployFixture);
      expect(
        await controller.hasRole(
          await controller.DEFAULT_ADMIN_ROLE(),
          admin.address
        )
      ).to.be.true;
      expect(await controller.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // setUpgrader rotation
  // ─────────────────────────────────────────────────────────────────────────
  describe("setUpgrader", function () {
    it("Should rotate upgrader when called by DEFAULT_ADMIN_ROLE", async function () {
      const { controller, admin, newUpgrader } = await loadFixture(
        freshDeployFixture
      );

      await expect(
        controller.connect(admin).setUpgrader(newUpgrader.address)
      )
        .to.emit(controller, "UpgraderUpdated")
        .withArgs(admin.address, newUpgrader.address);

      expect(await controller.upgrader()).to.equal(newUpgrader.address);
    });

    it("Should reject non-admin caller", async function () {
      const { controller, attacker, newUpgrader } = await loadFixture(
        freshDeployFixture
      );
      await expect(
        controller.connect(attacker).setUpgrader(newUpgrader.address)
      ).to.be.revertedWithCustomError(
        controller,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("Should reject address(0)", async function () {
      const { controller, admin } = await loadFixture(freshDeployFixture);
      await expect(
        controller.connect(admin).setUpgrader(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid upgrader");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // scheduleUpgrade / cancelUpgrade now gated by onlyUpgrader
  // ─────────────────────────────────────────────────────────────────────────
  describe("scheduleUpgrade / cancelUpgrade gating", function () {
    it("Should let upgrader schedule (default = safe address)", async function () {
      const { controller, admin, newImplAddr } = await loadFixture(
        freshDeployFixture
      );
      await expect(
        controller.connect(admin).scheduleUpgrade(newImplAddr)
      ).to.emit(controller, "UpgradeScheduled");
      expect(await controller.scheduledImplementation()).to.equal(newImplAddr);
    });

    it("Should revert with NotUpgrader when caller is not upgrader", async function () {
      const { controller, attacker, newImplAddr } = await loadFixture(
        freshDeployFixture
      );
      await expect(
        controller.connect(attacker).scheduleUpgrade(newImplAddr)
      ).to.be.revertedWithCustomError(controller, "NotUpgrader");
    });

    it("Should revert cancelUpgrade with NotUpgrader for non-upgrader", async function () {
      const { controller, admin, attacker, newImplAddr } = await loadFixture(
        freshDeployFixture
      );
      await controller.connect(admin).scheduleUpgrade(newImplAddr);
      await expect(
        controller.connect(attacker).cancelUpgrade()
      ).to.be.revertedWithCustomError(controller, "NotUpgrader");
    });

    it("Should follow rotated upgrader after setUpgrader", async function () {
      const { controller, admin, newUpgrader, newImplAddr } = await loadFixture(
        freshDeployFixture
      );

      await controller.connect(admin).setUpgrader(newUpgrader.address);

      // Old upgrader (admin) is now blocked from scheduling.
      await expect(
        controller.connect(admin).scheduleUpgrade(newImplAddr)
      ).to.be.revertedWithCustomError(controller, "NotUpgrader");

      // New upgrader can.
      await expect(
        controller.connect(newUpgrader).scheduleUpgrade(newImplAddr)
      ).to.emit(controller, "UpgradeScheduled");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // _authorizeUpgrade end-to-end via upgradeToAndCall
  // ─────────────────────────────────────────────────────────────────────────
  describe("_authorizeUpgrade (via upgradeToAndCall)", function () {
    it("Should revert with NotUpgrader when caller is not upgrader", async function () {
      const { controller, admin, attacker, newImplAddr } = await loadFixture(
        freshDeployFixture
      );
      await controller.connect(admin).scheduleUpgrade(newImplAddr);
      await time.increase(UPGRADE_DELAY + 1);

      await expect(
        controller.connect(attacker).upgradeToAndCall(newImplAddr, "0x")
      ).to.be.revertedWithCustomError(controller, "NotUpgrader");
    });

    it("Should succeed after timelock and clear scheduled state", async function () {
      const { controller, admin, newImplAddr } = await loadFixture(
        freshDeployFixture
      );
      await controller.connect(admin).scheduleUpgrade(newImplAddr);
      await time.increase(UPGRADE_DELAY + 1);

      await expect(
        controller.connect(admin).upgradeToAndCall(newImplAddr, "0x")
      ).to.not.be.reverted;

      expect(await controller.scheduledImplementation()).to.equal(
        hre.ethers.ZeroAddress
      );
      expect(await controller.upgradeScheduledAt()).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // withdrawToken moved from onlyOwner to onlyRole(DEFAULT_ADMIN_ROLE)
  // ─────────────────────────────────────────────────────────────────────────
  describe("withdrawToken access", function () {
    async function withErc20Fixture() {
      const base = await freshDeployFixture();
      const { controller, recipient } = base;

      // Deploy a throwaway ERC20 (use IDRP factory itself — initialize and
      // mint to controller's address via depository wallet workflow).
      const ERC20Factory = await hre.ethers.getContractFactory("IDRP");
      const stray = await hre.upgrades.deployProxy(ERC20Factory, [
        base.admin.address,
      ]);
      await stray.waitForDeployment();
      // @ts-ignore — IDRP exposes grantRole/MINTER_ROLE
      await stray.grantRole(await stray.MINTER_ROLE(), base.admin.address);
      // @ts-ignore — IDRP exposes setDepositoryWallet/mint
      await stray.setDepositoryWallet(await controller.getAddress());
      // @ts-ignore
      await stray.mint(1000n);

      return { ...base, stray, recipient };
    }

    it("Should let DEFAULT_ADMIN_ROLE withdraw stuck tokens", async function () {
      const { controller, admin, stray, recipient } = await loadFixture(
        withErc20Fixture
      );
      await expect(
        controller
          .connect(admin)
          .withdrawToken(await stray.getAddress(), recipient.address, 100n)
      ).to.emit(controller, "TokensWithdrawn");
      expect(await stray.balanceOf(recipient.address)).to.equal(100n);
    });

    it("Should reject non-admin caller", async function () {
      const { controller, attacker, stray, recipient } = await loadFixture(
        withErc20Fixture
      );
      await expect(
        controller
          .connect(attacker)
          .withdrawToken(await stray.getAddress(), recipient.address, 100n)
      ).to.be.revertedWithCustomError(
        controller,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Storage preservation: v1 (with Ownable) → v2 (without Ownable)
  // This is the core safety claim of the V4-2 fix.
  // ─────────────────────────────────────────────────────────────────────────
  describe("Storage preservation across v1 → v2 upgrade", function () {
    async function v1ProxyFixture() {
      const [admin, attacker, newUpgrader] = await hre.ethers.getSigners();

      const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
      const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
      await idrp.waitForDeployment();

      const V1Factory = await hre.ethers.getContractFactory(
        "IDRPControllerV1Mock"
      );
      const controllerV1 = await hre.upgrades.deployProxy(
        V1Factory,
        [await idrp.getAddress(), admin.address],
        { kind: "uups" }
      );
      await controllerV1.waitForDeployment();

      // Populate state on v1: quorum rule, scheduled-upgrade slot, idrpToken,
      // role memberships. Anything that's *not* OZ-namespaced storage.
      const QuorumRule = [
        {
          minAmount: 0,
          maxAmount: hre.ethers.MaxUint256,
          requiredRoles: [
            hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE")),
            hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE")),
          ],
        },
      ];
      await controllerV1
        .connect(admin)
        .setQuorumRulesRaw(OperationType.Mint, QuorumRule);

      const fakeImpl = "0x000000000000000000000000000000000000bEEF";
      const fakeTs = 12345678n;
      await controllerV1
        .connect(admin)
        .setScheduledImplementationRaw(fakeImpl, fakeTs);

      return {
        idrp,
        controllerV1,
        admin,
        attacker,
        newUpgrader,
        savedRule: QuorumRule[0],
        savedImpl: fakeImpl,
        savedTs: fakeTs,
      };
    }

    it("Should preserve idrpToken, quorumRules, scheduled state, and roles after upgrade", async function () {
      const {
        idrp,
        controllerV1,
        admin,
        savedRule,
        savedImpl,
        savedTs,
      } = await loadFixture(v1ProxyFixture);

      const proxyAddr = await controllerV1.getAddress();

      // Snapshot what we expect to survive the upgrade.
      const expectedIdrp = await idrp.getAddress();
      const expectedRule = await controllerV1.quorumRules(
        OperationType.Mint,
        0
      );
      expect(expectedRule.minAmount).to.equal(savedRule.minAmount);
      expect(expectedRule.maxAmount).to.equal(savedRule.maxAmount);

      // Run the actual upgrade. The OZ plugin will refuse if storage is
      // incompatible. We allow the renamed/removed parent contract since
      // OwnableUpgradeable in v5 lives entirely in ERC-7201 namespaced
      // storage and its removal cannot collide with anything sequential.
      const V2Factory = await hre.ethers.getContractFactory("IDRPController");
      const upgraded = await hre.upgrades.upgradeProxy(proxyAddr, V2Factory, {
        unsafeAllow: ["missing-initializer-call"],
      });
      await upgraded.waitForDeployment();

      // Sanity: same proxy address.
      expect(await upgraded.getAddress()).to.equal(proxyAddr);

      // Sequential storage all preserved.
      expect(await upgraded.idrpToken()).to.equal(expectedIdrp);
      expect(await upgraded.scheduledImplementation()).to.equal(savedImpl);
      expect(await upgraded.upgradeScheduledAt()).to.equal(savedTs);

      const ruleAfter = await upgraded.quorumRules(OperationType.Mint, 0);
      expect(ruleAfter.minAmount).to.equal(savedRule.minAmount);
      expect(ruleAfter.maxAmount).to.equal(savedRule.maxAmount);

      // AccessControl namespaced storage preserved.
      expect(
        await upgraded.hasRole(
          await upgraded.DEFAULT_ADMIN_ROLE(),
          admin.address
        )
      ).to.be.true;
      expect(await upgraded.hasRole(ADMIN_ROLE, admin.address)).to.be.true;

      // New variable starts zeroed — must be migrated via initializeV2.
      expect(await upgraded.upgrader()).to.equal(hre.ethers.ZeroAddress);
    });

    it("Should let DEFAULT_ADMIN_ROLE migrate via initializeV2 after upgrade", async function () {
      const { controllerV1, admin, newUpgrader } = await loadFixture(
        v1ProxyFixture
      );

      const V2Factory = await hre.ethers.getContractFactory("IDRPController");
      const upgraded = await hre.upgrades.upgradeProxy(
        await controllerV1.getAddress(),
        V2Factory,
        { unsafeAllow: ["missing-initializer-call"] }
      );
      await upgraded.waitForDeployment();

      await expect(
        upgraded.connect(admin).initializeV2(newUpgrader.address)
      )
        .to.emit(upgraded, "UpgraderUpdated")
        .withArgs(hre.ethers.ZeroAddress, newUpgrader.address);

      expect(await upgraded.upgrader()).to.equal(newUpgrader.address);
    });

    it("Should reject initializeV2 from a frontrunner attacker (V4-1 mirror)", async function () {
      const { controllerV1, attacker } = await loadFixture(v1ProxyFixture);

      const V2Factory = await hre.ethers.getContractFactory("IDRPController");
      const upgraded = await hre.upgrades.upgradeProxy(
        await controllerV1.getAddress(),
        V2Factory,
        { unsafeAllow: ["missing-initializer-call"] }
      );
      await upgraded.waitForDeployment();

      await expect(
        upgraded.connect(attacker).initializeV2(attacker.address)
      ).to.be.revertedWithCustomError(
        upgraded,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("Should reject second initializeV2 call (reinitializer(2) protection)", async function () {
      const { controllerV1, admin, newUpgrader } = await loadFixture(
        v1ProxyFixture
      );

      const V2Factory = await hre.ethers.getContractFactory("IDRPController");
      const upgraded = await hre.upgrades.upgradeProxy(
        await controllerV1.getAddress(),
        V2Factory,
        { unsafeAllow: ["missing-initializer-call"] }
      );
      await upgraded.waitForDeployment();

      await upgraded.connect(admin).initializeV2(newUpgrader.address);

      await expect(
        upgraded.connect(admin).initializeV2(newUpgrader.address)
      ).to.be.revertedWithCustomError(upgraded, "InvalidInitialization");
    });
  });
});

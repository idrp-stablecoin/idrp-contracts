import hre from "hardhat"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { upgradeTronProxy } from "../../utils/tron-upgrade"

/**
 * [V3-3] no-access-control v3 migration — IDRP historical-replay paths.
 *
 * Production proxies are on v2 (verified). But testnets, future chains, and
 * any chain that was deployed but never v2-migrated could be on v1. So we
 * test the two alternative migration shapes:
 *
 *   v1 → v3 directly (skip v2): reinitializer(3) accepts a proxy at
 *                                _initialized == 1 because OZ Initializable
 *                                doesn't replay earlier versions.
 *   v1 → v2 → v3 sequentially:  the full historical replay; every initializer
 *                                runs in order.
 *
 * Storage layout must survive in either case. If the OZ Upgrades plugin
 * refuses any of these transitions, this test fails.
 */
describe("[V3-3] IDRP — historical-replay paths to v3", function () {
  async function freshV1Fixture() {
    const [admin, controllerEOA, upgraderEOA, user] = await hre.ethers.getSigners()

    const V1Factory = await hre.ethers.getContractFactory("IDRPV1Mock")
    const idrpV1 = await hre.upgrades.deployProxy(V1Factory, [admin.address], {
      kind: "uups",
    })
    await idrpV1.waitForDeployment()

    // Populate v1 state.
    await idrpV1.connect(admin).setDepositoryWalletRaw(user.address)
    await idrpV1.connect(admin).setFrozenRaw(user.address, true)
    await idrpV1.connect(admin).mintRaw(user.address, 1_000_000n)

    return {
      idrpV1,
      proxyAddr: await idrpV1.getAddress(),
      admin,
      controllerEOA,
      upgraderEOA,
      user,
    }
  }

  describe("v1 → v3 (skip v2)", function () {
    it("preserves v1 storage and runs initializeV3 onlyUpgrader", async function () {
      const { idrpV1, proxyAddr, admin, controllerEOA, upgraderEOA, user } =
        await loadFixture(freshV1Fixture)

      const expectedDepository = await idrpV1.depositoryWallet()
      const expectedFrozen = await idrpV1.frozen(user.address)
      const expectedBalance = await idrpV1.balanceOf(user.address)

      // Skip v2 entirely — upgrade straight to v3.
      const V3Factory = await hre.ethers.getContractFactory("IDRP")
      const idrpV3 = await upgradeTronProxy(proxyAddr, "IDRP")
      await idrpV3.waitForDeployment()

      // v1 storage survives.
      expect(await idrpV3.depositoryWallet()).to.equal(expectedDepository)
      expect(await idrpV3.frozen(user.address)).to.equal(expectedFrozen)
      expect(await idrpV3.balanceOf(user.address)).to.equal(expectedBalance)

      // v2/v3 slots: zero (never written).
      expect(await idrpV3.upgrader()).to.equal(hre.ethers.ZeroAddress)
      expect(await idrpV3.maxSupply()).to.equal(0n)
      expect(await idrpV3.sanctionsList()).to.equal(hre.ethers.ZeroAddress)
      expect(await idrpV3.admin()).to.equal(hre.ethers.ZeroAddress)
      expect(await idrpV3.controller()).to.equal(hre.ethers.ZeroAddress)

      // upgrader is ZeroAddress on a v1 proxy, so onlyUpgrader can't run.
      // This is the testnet-remediation case documented in plan: such a chain
      // must run initializeV2 first to populate upgrader before v3.
      await expect(
        idrpV3
          .connect(admin)
          .initializeV3(admin.address, controllerEOA.address, upgraderEOA.address)
      ).to.be.revertedWithCustomError(idrpV3, "NotUpgrader")
    })
  })

  describe("v1 → v2 → v3 (full historical replay via legacy contracts)", function () {
    // The v1 → v2 step uses the REAL legacy v2 contract (contracts/legacy/IDRPv2.sol),
    // which is what testnet remediation actually deploys (scripts/v1-to-v2/). The
    // v2 → v3 step is the same production path every mainnet uses.
    it("runs initializeV2 then initializeV3 cleanly with all state preserved", async function () {
      const { idrpV1, proxyAddr, admin, controllerEOA, upgraderEOA, user } =
        await loadFixture(freshV1Fixture)

      const expectedDepository = await idrpV1.depositoryWallet()
      const expectedFrozen = await idrpV1.frozen(user.address)
      const expectedBalance = await idrpV1.balanceOf(user.address)

      // Step 1: v1 → legacy v2.
      const LegacyV2Factory = await hre.ethers.getContractFactory("IDRPv2")
      const idrpV2 = await upgradeTronProxy(proxyAddr, "IDRPv2")
      await idrpV2.waitForDeployment()

      // v1 granted UPGRADER_ROLE to the superAdmin (= admin in this fixture);
      // initializeV2 revokes that legacy holder and sets the v2 `upgrader`.
      await idrpV2
        .connect(admin)
        .initializeV2(admin.address, [admin.address])

      expect(await idrpV2.upgrader()).to.equal(admin.address)
      expect(await idrpV2.depositoryWallet()).to.equal(expectedDepository)
      expect(await idrpV2.balanceOf(user.address)).to.equal(expectedBalance)

      // Step 2: v2 → v3 (production path). Legacy v2 enforces a 48h timelock:
      // schedule the upgrade, advance time, then execute via upgradeToAndCall
      // so initializeV3 runs atomically with the impl swap.
      const V3Factory = await hre.ethers.getContractFactory("IDRP")
      const v3ImplAddr = await hre.upgrades.prepareUpgrade(proxyAddr, V3Factory, {
        unsafeAllow: ["missing-initializer-call"],
      })
      await idrpV2.connect(admin).scheduleUpgrade(v3ImplAddr)
      await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1])
      await hre.network.provider.send("evm_mine")

      const initV3Data = V3Factory.interface.encodeFunctionData("initializeV3", [
        admin.address,
        controllerEOA.address,
        upgraderEOA.address,
      ])
      await idrpV2.connect(admin).upgradeToAndCall(v3ImplAddr, initV3Data)

      const idrpV3 = V3Factory.attach(proxyAddr) as any

      // Final state: all the way through.
      expect(await idrpV3.depositoryWallet()).to.equal(expectedDepository)
      expect(await idrpV3.frozen(user.address)).to.equal(expectedFrozen)
      expect(await idrpV3.balanceOf(user.address)).to.equal(expectedBalance)
      expect(await idrpV3.admin()).to.equal(admin.address)
      expect(await idrpV3.controller()).to.equal(controllerEOA.address)
      expect(await idrpV3.upgrader()).to.equal(upgraderEOA.address)
    })

    it("v3 final impl no longer exposes initializeV2 (audit-clean end-state)", async function () {
      const { proxyAddr, admin, controllerEOA, upgraderEOA } =
        await loadFixture(freshV1Fixture)

      const LegacyV2Factory = await hre.ethers.getContractFactory("IDRPv2")
      const idrpV2 = await upgradeTronProxy(proxyAddr, "IDRPv2")
      await idrpV2.waitForDeployment()
      await idrpV2.connect(admin).initializeV2(admin.address, [admin.address])

      // v2 → v3 via scheduled, timelocked upgradeToAndCall.
      const V3Factory = await hre.ethers.getContractFactory("IDRP")
      const v3ImplAddr = await hre.upgrades.prepareUpgrade(proxyAddr, V3Factory, {
        unsafeAllow: ["missing-initializer-call"],
      })
      await idrpV2.connect(admin).scheduleUpgrade(v3ImplAddr)
      await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1])
      await hre.network.provider.send("evm_mine")
      const initV3Data = V3Factory.interface.encodeFunctionData("initializeV3", [
        admin.address,
        controllerEOA.address,
        upgraderEOA.address,
      ])
      await idrpV2.connect(admin).upgradeToAndCall(v3ImplAddr, initV3Data)
      const idrpV3 = V3Factory.attach(proxyAddr) as any

      // The v3 final IDRP dropped AccessControlUpgradeable AND initializeV2.
      // The function does not exist on the v3 ABI at all.
      const idrpAny = idrpV3 as unknown as { initializeV2?: unknown }
      expect(typeof idrpAny.initializeV2).to.equal("undefined")

      // Even if a caller tries to invoke initializeV2 via the LEGACY ABI
      // fragment (i.e. with the right function selector), the proxy reverts —
      // because the v3 impl has no matching dispatch entry. The call returns
      // without a reason; we just confirm it doesn't succeed.
      const v2InterfacedAtV3 = LegacyV2Factory.attach(proxyAddr) as any
      await expect(
        v2InterfacedAtV3
          .connect(upgraderEOA)
          .initializeV2(admin.address, [admin.address])
      ).to.be.reverted
    })
  })
})

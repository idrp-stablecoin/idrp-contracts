import hre from "hardhat"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"

/**
 * [V3-1] no-access-control v3 migration — IDRP v2 → v3 storage preservation.
 *
 * This is THE production path: every mainnet IDRP proxy is currently on v2
 * (verified via deployment/logs/contracts/v2.IDRP.sol). The migration is:
 *   1. Upgrade impl to v3 interim.
 *   2. Call initializeV3(admin, controller, upgrader), gated by onlyUpgrader.
 *
 * This test pins that:
 *   - The OZ Upgrades plugin accepts the v2→v3 layout transition.
 *   - Every meaningful v2 storage slot survives the upgrade unchanged.
 *   - initializeV3 populates the three new authority slots.
 *   - Operational methods (freeze/mint/etc.) work via the new `controller` slot
 *     after migration.
 *
 * If this test ever fails, do NOT run the migration on mainnet until you
 * understand why.
 */
describe("[V3-1] IDRP — v2 → v3 storage preservation", function () {
  async function v2ProxyFixture() {
    const [admin, controllerEOA, upgraderEOA, user] = await hre.ethers.getSigners()

    const V2Factory = await hre.ethers.getContractFactory("IDRPV2Mock")
    const idrpV2 = await hre.upgrades.deployProxy(V2Factory, [admin.address], {
      kind: "uups",
    })
    await idrpV2.waitForDeployment()

    // Populate v2 state — everything that should survive the v3 upgrade.
    await idrpV2.connect(admin).setDepositoryWalletRaw(user.address)
    await idrpV2.connect(admin).setMaxSupplyRaw(1_000_000_000_000n)
    await idrpV2.connect(admin).setSanctionsListRaw(controllerEOA.address) // arbitrary non-zero
    await idrpV2.connect(admin).setFrozenRaw(user.address, true)
    await idrpV2.connect(admin).setScheduledUpgradeRaw(controllerEOA.address, 1234567n)

    // Mint some tokens so we can confirm balance preservation too.
    const minterRole = await idrpV2.MINTER_ROLE()
    await idrpV2.connect(admin).grantRole(minterRole, admin.address)
    await idrpV2.connect(admin).mintRaw(user.address, 1_000_000n)

    return {
      idrpV2,
      proxyAddr: await idrpV2.getAddress(),
      admin,
      controllerEOA,
      upgraderEOA,
      user,
    }
  }

  it("preserves every sequential storage slot across the v2 → v3 upgrade", async function () {
    const { idrpV2, proxyAddr, admin, user, controllerEOA } =
      await loadFixture(v2ProxyFixture)

    // Snapshot expected state on v2.
    const expectedDepository = await idrpV2.depositoryWallet()
    const expectedMaxSupply = await idrpV2.maxSupply()
    const expectedSanctionsList = await idrpV2.sanctionsList()
    const expectedUpgrader = await idrpV2.upgrader()
    const expectedFrozen = await idrpV2.frozen(user.address)
    const expectedScheduledImpl = await idrpV2.scheduledImplementation()
    const expectedScheduledAt = await idrpV2.upgradeScheduledAt()
    const expectedBalance = await idrpV2.balanceOf(user.address)
    const expectedTotalSupply = await idrpV2.totalSupply()

    // Run the actual upgrade — this is where OZ's storage check runs.
    const V3Factory = await hre.ethers.getContractFactory("IDRP")
    const idrpV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    })
    await idrpV3.waitForDeployment()

    // Sanity: same proxy address.
    expect(await idrpV3.getAddress()).to.equal(proxyAddr)

    // Sequential storage survived.
    expect(await idrpV3.depositoryWallet()).to.equal(expectedDepository)
    expect(await idrpV3.maxSupply()).to.equal(expectedMaxSupply)
    expect(await idrpV3.sanctionsList()).to.equal(expectedSanctionsList)
    expect(await idrpV3.upgrader()).to.equal(expectedUpgrader)
    expect(await idrpV3.frozen(user.address)).to.equal(expectedFrozen)
    expect(await idrpV3.scheduledImplementation()).to.equal(expectedScheduledImpl)
    expect(await idrpV3.upgradeScheduledAt()).to.equal(expectedScheduledAt)
    expect(await idrpV3.balanceOf(user.address)).to.equal(expectedBalance)
    expect(await idrpV3.totalSupply()).to.equal(expectedTotalSupply)

    // New v3 slots start zero — populated by initializeV3.
    expect(await idrpV3.admin()).to.equal(hre.ethers.ZeroAddress)
    expect(await idrpV3.controller()).to.equal(hre.ethers.ZeroAddress)
  })

  it("initializeV3 (onlyUpgrader) populates the three new authority slots", async function () {
    const { proxyAddr, admin, controllerEOA, upgraderEOA } =
      await loadFixture(v2ProxyFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRP")
    const idrpV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    })
    await idrpV3.waitForDeployment()

    // upgrader on v2 was set to `admin` during fixture init.
    await expect(
      idrpV3
        .connect(admin)
        .initializeV3(admin.address, controllerEOA.address, upgraderEOA.address)
    )
      .to.emit(idrpV3, "AdminUpdated")
      .withArgs(hre.ethers.ZeroAddress, admin.address)
      .and.to.emit(idrpV3, "ControllerUpdated")
      .withArgs(hre.ethers.ZeroAddress, controllerEOA.address)
      .and.to.emit(idrpV3, "UpgraderUpdated")
      .withArgs(admin.address, upgraderEOA.address)

    expect(await idrpV3.admin()).to.equal(admin.address)
    expect(await idrpV3.controller()).to.equal(controllerEOA.address)
    expect(await idrpV3.upgrader()).to.equal(upgraderEOA.address)
  })

  it("rejects initializeV3 from non-upgrader", async function () {
    const { proxyAddr, admin, controllerEOA, upgraderEOA, user } =
      await loadFixture(v2ProxyFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRP")
    const idrpV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    })
    await idrpV3.waitForDeployment()

    // `user` is not the upgrader.
    await expect(
      idrpV3
        .connect(user)
        .initializeV3(admin.address, controllerEOA.address, upgraderEOA.address)
    ).to.be.revertedWithCustomError(idrpV3, "NotUpgrader")
  })

  it("rejects a second initializeV3 call (reinitializer(3))", async function () {
    const { proxyAddr, admin, controllerEOA, upgraderEOA } =
      await loadFixture(v2ProxyFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRP")
    const idrpV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    })
    await idrpV3.waitForDeployment()

    await idrpV3
      .connect(admin)
      .initializeV3(admin.address, controllerEOA.address, upgraderEOA.address)

    // upgrader is now `upgraderEOA` — try with that.
    await expect(
      idrpV3
        .connect(upgraderEOA)
        .initializeV3(admin.address, controllerEOA.address, upgraderEOA.address)
    ).to.be.revertedWithCustomError(idrpV3, "InvalidInitialization")
  })

  it("operational methods (mint/freeze) work via `controller` after migration", async function () {
    const { proxyAddr, admin, controllerEOA, upgraderEOA, user } =
      await loadFixture(v2ProxyFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRP")
    const idrpV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    })
    await idrpV3.waitForDeployment()
    await idrpV3
      .connect(admin)
      .initializeV3(admin.address, controllerEOA.address, upgraderEOA.address)

    // Pre-migration `user` was frozen — unfreeze via the new `controller` slot.
    await idrpV3.connect(admin).setController(controllerEOA.address) // confirm idempotence
    await idrpV3.connect(controllerEOA).unfreeze(user.address)
    expect(await idrpV3.frozen(user.address)).to.equal(false)

    // EOA without the controller role can NOT freeze.
    await expect(
      idrpV3.connect(user).freeze(user.address)
    ).to.be.revertedWithCustomError(idrpV3, "NotController")
  })
})

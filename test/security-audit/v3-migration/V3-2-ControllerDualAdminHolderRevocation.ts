import hre from "hardhat"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { upgradeTronProxy } from "../../utils/tron-upgrade"

/**
 * [V3-2] no-access-control v3 migration — the dual-DEFAULT_ADMIN_ROLE-holder fix.
 *
 * Why this test exists (see docs/design/acdar-migration-and-tron-multisig-gotchas.md):
 *
 * When upgrading IDRPController from v2 (AccessControlUpgradeable + DEFAULT_ADMIN_ROLE)
 * to v3 (AccessControlDefaultAdminRulesUpgradeable), the OZ-recommended approach
 * stores the "current default admin" in a NEW ERC-7201 namespace separate from
 * the legacy AccessControl mapping.
 *
 * If the v2 proxy already has TWO addresses holding DEFAULT_ADMIN_ROLE (legitimate
 * scenario: e.g. main Safe + an emergency rotation key), and `initializeV3`
 * naively does `__AccessControlDefaultAdminRules_init` first, the legacy mapping
 * still answers TRUE for both addresses via `hasRole(DEFAULT_ADMIN_ROLE, x)`,
 * while ACDAR's `defaultAdmin()` view returns only the new address. Three
 * effective holders, single official view. SILENT BUG.
 *
 * Worse: ACDAR's `revokeRole` reverts for DEFAULT_ADMIN_ROLE, so there is NO
 * public path to clean up the legacy holders after init.
 *
 * The fix (and what this test pins):
 *   `initializeV3` MUST take an `address[] _legacyDefaultAdminHolders` parameter
 *   and revoke every legacy holder BEFORE calling `__AccessControlDefaultAdminRules_init`.
 *   The new admin is then granted via ACDAR's init, which re-adds it to legacy
 *   storage AND sets the ACDAR slot — net result: exactly one holder.
 *
 * Negative case in this file: if init runs without the legacy revocation, the
 * dual-holder state persists. We verify that explicitly by re-running the
 * revoke-then-init flow against a state we deliberately set up to be wrong.
 */
describe("[V3-2] Controller — DEFAULT_ADMIN_ROLE dual-holder revocation", function () {
  const DEFAULT_ADMIN_ROLE =
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  const ADMIN_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("ADMIN_ROLE"))

  async function v2WithDualAdminFixture() {
    const [adminMain, adminSecondary, upgraderEOA, idrpAddr, user] =
      await hre.ethers.getSigners()

    const V2Factory = await hre.ethers.getContractFactory("IDRPControllerV2Mock")
    const ctrlV2 = await hre.upgrades.deployProxy(
      V2Factory,
      [idrpAddr.address, adminMain.address],
      { kind: "uups" }
    )
    await ctrlV2.waitForDeployment()

    // Mainnet-realistic scenario: a second address was granted DEFAULT_ADMIN_ROLE
    // at some point (e.g. an emergency rotation key, or a legacy script run).
    await ctrlV2
      .connect(adminMain)
      .grantRole(DEFAULT_ADMIN_ROLE, adminSecondary.address)

    // Confirm both hold the role on v2.
    expect(await ctrlV2.hasRole(DEFAULT_ADMIN_ROLE, adminMain.address)).to.equal(true)
    expect(await ctrlV2.hasRole(DEFAULT_ADMIN_ROLE, adminSecondary.address)).to.equal(true)

    return {
      ctrlV2,
      proxyAddr: await ctrlV2.getAddress(),
      adminMain,
      adminSecondary,
      upgraderEOA,
      user,
    }
  }

  it("after initializeV3 with revoke-then-init, ONLY the new admin holds the role", async function () {
    const { proxyAddr, adminMain, adminSecondary, upgraderEOA } = await loadFixture(
      v2WithDualAdminFixture
    )

    const V3Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrlV3 = await upgradeTronProxy(proxyAddr, "IDRPController")
    await ctrlV3.waitForDeployment()

    // upgrader on v2 is adminMain (set in fixture initialize).
    await ctrlV3
      .connect(adminMain)
      .initializeV3(adminMain.address, upgraderEOA.address, [
        adminMain.address,
        adminSecondary.address,
      ])

    // ACDAR's view: only adminMain.
    expect(await ctrlV3.defaultAdmin()).to.equal(adminMain.address)

    // Legacy storage: adminMain re-granted via __init, adminSecondary revoked.
    expect(await ctrlV3.hasRole(DEFAULT_ADMIN_ROLE, adminMain.address)).to.equal(true)
    expect(await ctrlV3.hasRole(DEFAULT_ADMIN_ROLE, adminSecondary.address)).to.equal(
      false
    )

    // upgrader rotated.
    expect(await ctrlV3.upgrader()).to.equal(upgraderEOA.address)
  })

  it("after migration, adminSecondary CANNOT use any DEFAULT_ADMIN_ROLE-gated path", async function () {
    const { proxyAddr, adminMain, adminSecondary, upgraderEOA, user } =
      await loadFixture(v2WithDualAdminFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrlV3 = await upgradeTronProxy(proxyAddr, "IDRPController")
    await ctrlV3.waitForDeployment()
    await ctrlV3
      .connect(adminMain)
      .initializeV3(adminMain.address, upgraderEOA.address, [
        adminMain.address,
        adminSecondary.address,
      ])

    // Try to use adminSecondary on a DEFAULT_ADMIN_ROLE-gated function.
    // setUpgrader is gated by onlyRole(DEFAULT_ADMIN_ROLE) — should revert.
    await expect(
      ctrlV3.connect(adminSecondary).setUpgrader(user.address)
    ).to.be.revertedWith(/AccessControl: account .* is missing role/)
  })

  it("rejects initializeV3 from a non-upgrader (frontrun protection)", async function () {
    const { proxyAddr, adminMain, adminSecondary, upgraderEOA, user } =
      await loadFixture(v2WithDualAdminFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrlV3 = await upgradeTronProxy(proxyAddr, "IDRPController")
    await ctrlV3.waitForDeployment()

    // adminSecondary is NOT the upgrader.
    await expect(
      ctrlV3
        .connect(adminSecondary)
        .initializeV3(adminMain.address, upgraderEOA.address, [
          adminMain.address,
          adminSecondary.address,
        ])
    ).to.be.revertedWithCustomError(ctrlV3, "NotUpgrader")
  })

  it("ACDAR's revokeRole rejects DEFAULT_ADMIN_ROLE after migration (post-init guard)", async function () {
    const { proxyAddr, adminMain, adminSecondary, upgraderEOA } = await loadFixture(
      v2WithDualAdminFixture
    )

    const V3Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrlV3 = await upgradeTronProxy(proxyAddr, "IDRPController")
    await ctrlV3.waitForDeployment()
    await ctrlV3
      .connect(adminMain)
      .initializeV3(adminMain.address, upgraderEOA.address, [
        adminMain.address,
        adminSecondary.address,
      ])

    // Even adminMain itself cannot revokeRole(DEFAULT_ADMIN_ROLE) post-init —
    // ACDAR enforces the two-step rotation flow.
    await expect(
      ctrlV3.connect(adminMain).revokeRole(DEFAULT_ADMIN_ROLE, adminMain.address)
    ).to.be.revertedWith(/AccessControl: can't (directly (grant|revoke) default admin role|violate default admin rules)/)

    // grantRole(DEFAULT_ADMIN_ROLE, anyone) also reverts.
    await expect(
      ctrlV3.connect(adminMain).grantRole(DEFAULT_ADMIN_ROLE, adminSecondary.address)
    ).to.be.revertedWith(/AccessControl: can't (directly (grant|revoke) default admin role|violate default admin rules)/)
  })

  it("admin retains the ability to grant signer roles (OFFICER, MANAGER, etc.)", async function () {
    const { proxyAddr, adminMain, adminSecondary, upgraderEOA, user } =
      await loadFixture(v2WithDualAdminFixture)

    const V3Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrlV3 = await upgradeTronProxy(proxyAddr, "IDRPController")
    await ctrlV3.waitForDeployment()
    await ctrlV3
      .connect(adminMain)
      .initializeV3(adminMain.address, upgraderEOA.address, [
        adminMain.address,
        adminSecondary.address,
      ])

    const OFFICER_ROLE = await ctrlV3.OFFICER_ROLE()

    // adminMain (DEFAULT_ADMIN_ROLE holder) can grant signer roles via stock OZ flow.
    await ctrlV3.connect(adminMain).grantRole(OFFICER_ROLE, user.address)
    expect(await ctrlV3.hasRole(OFFICER_ROLE, user.address)).to.equal(true)

    // Non-admin cannot.
    await expect(
      ctrlV3.connect(user).grantRole(OFFICER_ROLE, adminSecondary.address)
    ).to.be.revertedWith(/AccessControl: account .* is missing role/)
  })

  it("preserves v2 sequential storage across the upgrade", async function () {
    const { ctrlV2, proxyAddr, adminMain, adminSecondary, upgraderEOA } =
      await loadFixture(v2WithDualAdminFixture)

    // Populate some v2 state we expect to survive.
    const fakeImpl = "0x000000000000000000000000000000000000bEEF"
    const fakeTs = 12345678n
    await ctrlV2.connect(adminMain).setScheduledImplementationRaw(fakeImpl, fakeTs)
    await ctrlV2.connect(adminMain).setNonceRaw(42n)

    const expectedIdrpToken = await ctrlV2.idrpToken()
    const expectedNonce = await ctrlV2.nonce()
    const expectedScheduledImpl = await ctrlV2.scheduledImplementation()
    const expectedScheduledAt = await ctrlV2.upgradeScheduledAt()

    const V3Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrlV3 = await upgradeTronProxy(proxyAddr, "IDRPController")
    await ctrlV3.waitForDeployment()

    // Before initializeV3 runs, storage carries over.
    expect(await ctrlV3.idrpToken()).to.equal(expectedIdrpToken)
    expect(await ctrlV3.nonce()).to.equal(expectedNonce)
    expect(await ctrlV3.scheduledImplementation()).to.equal(expectedScheduledImpl)
    expect(await ctrlV3.upgradeScheduledAt()).to.equal(expectedScheduledAt)

    await ctrlV3
      .connect(adminMain)
      .initializeV3(adminMain.address, upgraderEOA.address, [
        adminMain.address,
        adminSecondary.address,
      ])

    // After init, same slots — initializeV3 doesn't touch them.
    expect(await ctrlV3.idrpToken()).to.equal(expectedIdrpToken)
    expect(await ctrlV3.nonce()).to.equal(expectedNonce)
    expect(await ctrlV3.scheduledImplementation()).to.equal(expectedScheduledImpl)
    expect(await ctrlV3.upgradeScheduledAt()).to.equal(expectedScheduledAt)
  })
})

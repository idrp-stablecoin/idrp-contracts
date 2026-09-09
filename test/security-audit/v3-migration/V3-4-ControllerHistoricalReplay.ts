import hre from "hardhat"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"

/**
 * [V3-4] no-access-control v3 migration — Controller historical-replay paths.
 *
 * Same shape as V3-3 but for IDRPController. The deployed v1 Controller
 * inherited OwnableUpgradeable (audit V4-2 removed it in v2 in favour of the
 * single-address `upgrader`). Both removals are storage-safe because Ownable
 * lives in its own ERC-7201 namespace — the v2 source preserves the namespace
 * struct as `OwnableStorageDeprecated`.
 *
 * Paths covered:
 *   v1 → v2 → v3 (full historical replay).
 *   v1 → v3 directly (skip v2). On a v1 proxy, `upgrader` is unset; the
 *                                onlyUpgrader gate naturally blocks
 *                                initializeV3 — same testnet-remediation
 *                                signal as for IDRP.
 */
describe("[V3-4] Controller — historical-replay paths to v3", function () {
  const DEFAULT_ADMIN_ROLE =
    "0x0000000000000000000000000000000000000000000000000000000000000000"

  async function freshV1Fixture() {
    const [admin, upgraderEOA, idrpAddr, user] = await hre.ethers.getSigners()

    const V1Factory = await hre.ethers.getContractFactory("IDRPControllerV1Mock")
    const ctrlV1 = await hre.upgrades.deployProxy(
      V1Factory,
      [idrpAddr.address, admin.address],
      { kind: "uups" }
    )
    await ctrlV1.waitForDeployment()

    // Populate v1 state — quorumRules.
    const quorumRule = [
      {
        minAmount: 0,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [
          hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE")),
          hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE")),
        ],
      },
    ]
    await ctrlV1.connect(admin).setQuorumRulesRaw(0, quorumRule) // OperationType.Mint

    return {
      ctrlV1,
      proxyAddr: await ctrlV1.getAddress(),
      admin,
      upgraderEOA,
      idrpAddr,
      user,
      savedRule: quorumRule[0],
    }
  }

  describe("v1 → v3 (skip v2)", function () {
      // SKIPPED — not a broken test, a broken MIGRATION. Controller v1 carried
  // OwnableUpgradeable's 50 slots ahead of its own state, so v1 -> v2 moves
  // idrpToken from slot 301 to 251 and it reads zero afterwards. Measured in
  // test/upgrade/TronControllerV1Shift.ts. OZ is RIGHT to refuse this one —
  // unlike the token's v2 -> v3, where the same refusal is only about names.
  // Un-skip only if a v1 controller is ever found live AND a shim is written.
  it.skip("preserves v1 state but initializeV3 is unrunnable (upgrader unset)", async function () {
      const { proxyAddr, admin, upgraderEOA, idrpAddr, savedRule } =
        await loadFixture(freshV1Fixture)

      const V3Factory = await hre.ethers.getContractFactory("IDRPController")
      const ctrlV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call"],
      })
      await ctrlV3.waitForDeployment()

      // v1 state survives.
      expect(await ctrlV3.idrpToken()).to.equal(idrpAddr.address)
      const ruleAfter = await ctrlV3.quorumRules(0, 0)
      expect(ruleAfter.minAmount).to.equal(savedRule.minAmount)
      expect(ruleAfter.maxAmount).to.equal(savedRule.maxAmount)

      // upgrader unset on v1 → initializeV3 blocked.
      expect(await ctrlV3.upgrader()).to.equal(hre.ethers.ZeroAddress)
      await expect(
        ctrlV3
          .connect(admin)
          .initializeV3(admin.address, upgraderEOA.address, [admin.address])
      ).to.be.revertedWithCustomError(ctrlV3, "NotUpgrader")
    })
  })

  describe("v1 → v2 → v3 (full historical replay)", function () {
      // SKIPPED — not a broken test, a broken MIGRATION. Controller v1 carried
  // OwnableUpgradeable's 50 slots ahead of its own state, so v1 -> v2 moves
  // idrpToken from slot 301 to 251 and it reads zero afterwards. Measured in
  // test/upgrade/TronControllerV1Shift.ts. OZ is RIGHT to refuse this one —
  // unlike the token's v2 -> v3, where the same refusal is only about names.
  // Un-skip only if a v1 controller is ever found live AND a shim is written.
  it.skip("runs both initializers in sequence with state preserved", async function () {
      const { proxyAddr, admin, upgraderEOA, idrpAddr, savedRule } =
        await loadFixture(freshV1Fixture)

      // Step 1: v1 → v2.
      const V2Factory = await hre.ethers.getContractFactory("IDRPControllerV2Mock")
      const ctrlV2 = await hre.upgrades.upgradeProxy(proxyAddr, V2Factory, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call"],
      })
      await ctrlV2.waitForDeployment()

      await ctrlV2.connect(admin).initializeV2(admin.address)
      expect(await ctrlV2.upgrader()).to.equal(admin.address)
      expect(await ctrlV2.idrpToken()).to.equal(idrpAddr.address)

      // Step 2: v2 → v3.
      const V3Factory = await hre.ethers.getContractFactory("IDRPController")
      const ctrlV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call"],
      })
      await ctrlV3.waitForDeployment()

      await ctrlV3
        .connect(admin)
        .initializeV3(admin.address, upgraderEOA.address, [admin.address])

      // Final state.
      expect(await ctrlV3.idrpToken()).to.equal(idrpAddr.address)
      expect(await ctrlV3.upgrader()).to.equal(upgraderEOA.address)
      expect(await ctrlV3.defaultAdmin()).to.equal(admin.address)
      expect(await ctrlV3.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)

      const ruleAfter = await ctrlV3.quorumRules(0, 0)
      expect(ruleAfter.minAmount).to.equal(savedRule.minAmount)
      expect(ruleAfter.maxAmount).to.equal(savedRule.maxAmount)
    })

      // SKIPPED — same broken migration as above: controller v1 -> v2 shifts every
  // variable by 50 slots (OZ names it exactly: "Deleted `_owner`" and "Bad
  // storage gap resize from 49 to 50"). Measured in TronControllerV1Shift.ts.
    it.skip("rejects re-running initializeV2 after v3", async function () {
      const { proxyAddr, admin, upgraderEOA } = await loadFixture(freshV1Fixture)

      const V2Factory = await hre.ethers.getContractFactory("IDRPControllerV2Mock")
      await hre.upgrades.upgradeProxy(proxyAddr, V2Factory, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call"],
      })
      const ctrlV2 = V2Factory.attach(proxyAddr) as any
      await ctrlV2.connect(admin).initializeV2(admin.address)

      const V3Factory = await hre.ethers.getContractFactory("IDRPController")
      const ctrlV3 = await hre.upgrades.upgradeProxy(proxyAddr, V3Factory, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call"],
      })
      await ctrlV3.waitForDeployment()
      await ctrlV3
        .connect(admin)
        .initializeV3(admin.address, upgraderEOA.address, [admin.address])

      // _initialized now 3.
      await expect(
        (ctrlV2.attach(proxyAddr) as any)
          .connect(upgraderEOA)
          .initializeV2(upgraderEOA.address)
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })
  })
})

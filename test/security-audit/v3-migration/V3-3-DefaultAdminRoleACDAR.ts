import hre from "hardhat"
import { expect } from "chai"
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers"

/**
 * [V3-3] DEFAULT_ADMIN_ROLE — ACDAR steady-state invariants.
 *
 * V3-2 covers the v2→v3 migration boundary (revoke-then-init pattern,
 * legacy-holder cleanup). This file pins the *post-migration* invariants the
 * design doc (docs/design/no-defaultadmin-leftbehind.md) commits to:
 *
 *   1. There is always exactly ONE DEFAULT_ADMIN_ROLE holder, even after
 *      rotation. The legacy multi-holder problem cannot reappear via any
 *      public path.
 *
 *   2. Legacy-style direct mutation of DEFAULT_ADMIN_ROLE is blocked at every
 *      public entry point: grantRole, revokeRole, and the single-step
 *      renounceRole branch all revert with AccessControlEnforcedDefaultAdminRules.
 *
 *   3. The only legitimate way to rotate DEFAULT_ADMIN_ROLE is the ACDAR
 *      two-step + 48h delay flow: beginDefaultAdminTransfer → wait
 *      DEFAULT_ADMIN_DELAY → acceptDefaultAdminTransfer.
 *
 *   4. The renounce flow is similarly delayed and requires the explicit
 *      address(0) sentinel, so it cannot happen accidentally.
 *
 *   5. Any address that previously held DEFAULT_ADMIN_ROLE (e.g. a legacy
 *      v2 holder that initializeV3 cleaned up, OR the old admin after a
 *      legitimate rotation) cannot reach ANY DEFAULT_ADMIN_ROLE-gated method:
 *      setUpgrader, setQuorumRules, scheduleQuorumRules, applyQuorumRules,
 *      cancelQuorumRules, or grantRole/revokeRole on signer roles.
 */
describe("[V3-3] DEFAULT_ADMIN_ROLE — ACDAR steady-state invariants", function () {
  const DEFAULT_ADMIN_ROLE =
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  const ZERO = hre.ethers.ZeroAddress
  const DELAY = 48 * 60 * 60 // 48 hours, matches contract's DEFAULT_ADMIN_DELAY

  // Fresh v3 controller deployed cleanly (no v2→v3 migration), so the admin
  // surface is the steady state we're testing.
  async function freshV3Fixture() {
    const [admin, newAdmin, randomLegacy, signerCandidate, attacker] =
      await hre.ethers.getSigners()

    const idrpAddr = "0x000000000000000000000000000000000000d00d"
    const Factory = await hre.ethers.getContractFactory("IDRPController")
    const ctrl = await hre.upgrades.deployProxy(Factory, [idrpAddr, admin.address], {
      kind: "uups",
    })
    await ctrl.waitForDeployment()

    return { ctrl, admin, newAdmin, randomLegacy, signerCandidate, attacker }
  }

  describe("post-init steady state — single holder invariant", function () {
    it("exactly one DEFAULT_ADMIN_ROLE holder after fresh deploy", async function () {
      const { ctrl, admin, newAdmin, randomLegacy, attacker } = await loadFixture(
        freshV3Fixture
      )

      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
      // Every other signer is not an admin.
      for (const sig of [newAdmin, randomLegacy, attacker]) {
        expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, sig.address)).to.equal(false)
      }
    })

    it("defaultAdminDelay() returns the contract's DEFAULT_ADMIN_DELAY", async function () {
      const { ctrl } = await loadFixture(freshV3Fixture)
      expect(await ctrl.defaultAdminDelay()).to.equal(DELAY)
    })
  })

  describe("public mutation paths for DEFAULT_ADMIN_ROLE are blocked", function () {
    it("grantRole(DEFAULT_ADMIN_ROLE, X) reverts — admin cannot create a second holder", async function () {
      const { ctrl, admin, newAdmin } = await loadFixture(freshV3Fixture)

      await expect(
        ctrl.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, newAdmin.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlEnforcedDefaultAdminRules")

      // Sanity: no holder was added.
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, newAdmin.address)).to.equal(false)
      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
    })

    it("revokeRole(DEFAULT_ADMIN_ROLE, self) reverts — admin cannot single-tx revoke", async function () {
      const { ctrl, admin } = await loadFixture(freshV3Fixture)

      await expect(
        ctrl.connect(admin).revokeRole(DEFAULT_ADMIN_ROLE, admin.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlEnforcedDefaultAdminRules")

      // Admin still holds it.
      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
    })

    it("revokeRole(DEFAULT_ADMIN_ROLE, anyOther) reverts — same protection for non-holders", async function () {
      const { ctrl, admin, newAdmin } = await loadFixture(freshV3Fixture)

      await expect(
        ctrl.connect(admin).revokeRole(DEFAULT_ADMIN_ROLE, newAdmin.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlEnforcedDefaultAdminRules")
    })

    it("renounceRole(DEFAULT_ADMIN_ROLE, self) without scheduled transfer reverts", async function () {
      const { ctrl, admin } = await loadFixture(freshV3Fixture)

      // No pendingDefaultAdmin set, no schedule, no delay elapsed → revert.
      await expect(
        ctrl.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlEnforcedDefaultAdminDelay")

      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
    })
  })

  describe("legitimate rotation via ACDAR two-step + delay", function () {
    it("happy path: begin → wait 48h → accept, exactly one holder at every visible state", async function () {
      const { ctrl, admin, newAdmin } = await loadFixture(freshV3Fixture)

      // Step 1: admin begins the transfer.
      await ctrl.connect(admin).beginDefaultAdminTransfer(newAdmin.address)

      // Mid-transfer state: admin still the holder, newAdmin is pending only.
      const [pendingAddr, pendingSchedule] = await ctrl.pendingDefaultAdmin()
      expect(pendingAddr).to.equal(newAdmin.address)
      expect(pendingSchedule).to.be.greaterThan(0n)
      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, newAdmin.address)).to.equal(false)

      // Step 2: try to accept before delay → revert.
      await expect(
        ctrl.connect(newAdmin).acceptDefaultAdminTransfer()
      ).to.be.revertedWithCustomError(ctrl, "AccessControlEnforcedDefaultAdminDelay")

      // Wait the full delay.
      await time.increase(DELAY + 1)

      // Step 3: accept.
      await ctrl.connect(newAdmin).acceptDefaultAdminTransfer()

      // Post-rotation: newAdmin is the sole holder; admin lost the role entirely.
      expect(await ctrl.defaultAdmin()).to.equal(newAdmin.address)
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, newAdmin.address)).to.equal(true)
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(false)
    })

    it("only the current admin can begin a transfer", async function () {
      const { ctrl, newAdmin, attacker } = await loadFixture(freshV3Fixture)

      await expect(
        ctrl.connect(attacker).beginDefaultAdminTransfer(newAdmin.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })

    it("only the pending admin can accept the transfer", async function () {
      const { ctrl, admin, newAdmin, attacker } = await loadFixture(freshV3Fixture)

      await ctrl.connect(admin).beginDefaultAdminTransfer(newAdmin.address)
      await time.increase(DELAY + 1)

      await expect(
        ctrl.connect(attacker).acceptDefaultAdminTransfer()
      ).to.be.revertedWithCustomError(ctrl, "AccessControlInvalidDefaultAdmin")

      // newAdmin still has not accepted; admin is still the holder.
      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
    })

    it("current admin can cancel a pending transfer", async function () {
      const { ctrl, admin, newAdmin } = await loadFixture(freshV3Fixture)

      await ctrl.connect(admin).beginDefaultAdminTransfer(newAdmin.address)
      await ctrl.connect(admin).cancelDefaultAdminTransfer()

      // No pending admin anymore.
      const [pendingAddr, pendingSchedule] = await ctrl.pendingDefaultAdmin()
      expect(pendingAddr).to.equal(ZERO)
      expect(pendingSchedule).to.equal(0n)

      // After waiting the original delay, the would-be-newAdmin still can't claim.
      await time.increase(DELAY + 1)
      await expect(
        ctrl.connect(newAdmin).acceptDefaultAdminTransfer()
      ).to.be.revertedWithCustomError(ctrl, "AccessControlInvalidDefaultAdmin")

      expect(await ctrl.defaultAdmin()).to.equal(admin.address)
    })
  })

  describe("delayed renounce flow", function () {
    it("requires beginDefaultAdminTransfer(address(0)) + wait + renounceRole", async function () {
      const { ctrl, admin } = await loadFixture(freshV3Fixture)

      // Step 1: schedule renounce by setting pending admin to zero address.
      await ctrl.connect(admin).beginDefaultAdminTransfer(ZERO)

      // Before delay elapses, renounce reverts.
      await expect(
        ctrl.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlEnforcedDefaultAdminDelay")

      // After delay, renounce succeeds. From this point on, NO address holds
      // DEFAULT_ADMIN_ROLE — this is intentional and well-defined behavior, but
      // admin-gated methods (setUpgrader, setQuorumRules, scheduleQuorumRules,
      // grantRole on signer roles) all become unreachable. Signer roles and
      // executeOperation continue to work; upgrader can rescue if needed.
      await time.increase(DELAY + 1)
      await ctrl.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address)

      expect(await ctrl.defaultAdmin()).to.equal(ZERO)
      expect(await ctrl.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(false)
    })
  })

  describe("after rotation, the old admin loses ALL admin-gated capabilities", function () {
    async function rotatedFixture() {
      const ctx = await loadFixture(freshV3Fixture)
      const { ctrl, admin, newAdmin } = ctx
      await ctrl.connect(admin).beginDefaultAdminTransfer(newAdmin.address)
      await time.increase(DELAY + 1)
      await ctrl.connect(newAdmin).acceptDefaultAdminTransfer()
      return ctx
    }

    it("old admin cannot setUpgrader", async function () {
      const { ctrl, admin, attacker } = await rotatedFixture()
      await expect(
        ctrl.connect(admin).setUpgrader(attacker.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })

    it("old admin cannot setQuorumRules", async function () {
      const { ctrl, admin } = await rotatedFixture()
      const OperationType_Mint = 0
      const officerRole = await ctrl.OFFICER_ROLE()
      const managerRole = await ctrl.MANAGER_ROLE()
      const rule = {
        minAmount: 0n,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [officerRole, managerRole],
      }
      await expect(
        ctrl.connect(admin).setQuorumRules(OperationType_Mint, [rule])
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })

    it("old admin cannot scheduleQuorumRules / applyQuorumRules / cancelQuorumRules", async function () {
      const { ctrl, admin, newAdmin } = await rotatedFixture()
      const OperationType_Mint = 0
      const officerRole = await ctrl.OFFICER_ROLE()
      const managerRole = await ctrl.MANAGER_ROLE()
      const rule = {
        minAmount: 0n,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [officerRole, managerRole],
      }

      // Set rules via newAdmin so a CHANGE path is reachable.
      await ctrl.connect(newAdmin).setQuorumRules(OperationType_Mint, [rule])

      await expect(
        ctrl.connect(admin).scheduleQuorumRules(OperationType_Mint, [rule])
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
      await expect(
        ctrl.connect(admin).applyQuorumRules(OperationType_Mint)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
      await expect(
        ctrl.connect(admin).cancelQuorumRules(OperationType_Mint)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })

    it("old admin cannot grant or revoke signer roles", async function () {
      const { ctrl, admin, signerCandidate } = await rotatedFixture()
      const officerRole = await ctrl.OFFICER_ROLE()

      await expect(
        ctrl.connect(admin).grantRole(officerRole, signerCandidate.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
      await expect(
        ctrl.connect(admin).revokeRole(officerRole, signerCandidate.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })

    it("old admin cannot start another rotation", async function () {
      const { ctrl, admin, attacker } = await rotatedFixture()
      await expect(
        ctrl.connect(admin).beginDefaultAdminTransfer(attacker.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })

    it("the new admin can do everything the old admin used to", async function () {
      const { ctrl, newAdmin, signerCandidate, attacker } = await rotatedFixture()
      const officerRole = await ctrl.OFFICER_ROLE()

      // setUpgrader works.
      await ctrl.connect(newAdmin).setUpgrader(attacker.address)
      expect(await ctrl.upgrader()).to.equal(attacker.address)

      // signer-role management works.
      await ctrl.connect(newAdmin).grantRole(officerRole, signerCandidate.address)
      expect(await ctrl.hasRole(officerRole, signerCandidate.address)).to.equal(true)
      await ctrl.connect(newAdmin).revokeRole(officerRole, signerCandidate.address)
      expect(await ctrl.hasRole(officerRole, signerCandidate.address)).to.equal(false)
    })
  })

  describe("random unrelated address has zero admin reach", function () {
    it("a never-granted address cannot reach any DEFAULT_ADMIN_ROLE-gated method", async function () {
      const { ctrl, randomLegacy, attacker } = await loadFixture(freshV3Fixture)
      const officerRole = await ctrl.OFFICER_ROLE()
      const managerRole = await ctrl.MANAGER_ROLE()
      const OperationType_Mint = 0
      const rule = {
        minAmount: 0n,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [officerRole, managerRole],
      }

      // Every admin-gated entry point. The contract MUST treat this address
      // identically to any other unauthorized caller, regardless of any past
      // role state in legacy storage.
      await expect(
        ctrl.connect(randomLegacy).setUpgrader(attacker.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
      await expect(
        ctrl.connect(randomLegacy).setQuorumRules(OperationType_Mint, [rule])
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
      await expect(
        ctrl.connect(randomLegacy).grantRole(officerRole, attacker.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
      await expect(
        ctrl.connect(randomLegacy).beginDefaultAdminTransfer(attacker.address)
      ).to.be.revertedWithCustomError(ctrl, "AccessControlUnauthorizedAccount")
    })
  })
})

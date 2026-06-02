import hre from "hardhat"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { parseUnits } from "ethers"
import { deployIDRPv3ForTests } from "./utils/utils"

describe("IDRP", function () {
  // v3 unit-test fixture. The v3 model gates operational methods on
  // `msg.sender == controller`; for unit tests we set controller = defaultAdmin
  // so the existing test bodies (defaultAdmin.pause/mint/freeze) keep working.
  // The `defaultAdmin` signer is therefore acting as BOTH the admin slot
  // (config) AND the controller slot (operations). Production wires those
  // separately — that's covered by the integration / Safe / fork tests.
  async function contractFixture() {
    const [defaultAdmin, user, depository] = await hre.ethers.getSigners()
    const contract = await deployIDRPv3ForTests(
      defaultAdmin,
      defaultAdmin,
      depository.address
    )
    return { contract, defaultAdmin, user, depository }
  }

  describe("Deployment", function () {
    it("Should set the right name and symbol", async function () {
      const { contract } = await loadFixture(contractFixture)

      expect(await contract.name()).to.equal("IDRP")
      expect(await contract.symbol()).to.equal("IDRP")
    })
  })

  describe("Pausing", function () {
    it("Should pause and unpause", async function () {
      const { contract, defaultAdmin } = await loadFixture(contractFixture)

      await contract.connect(defaultAdmin).pause()
      expect(await contract.paused()).to.be.true

      await contract.connect(defaultAdmin).unpause()
      expect(await contract.paused()).to.be.false
    })

    it("Should not pause if not PAUSER_ROLE", async function () {
      const { contract, user } = await loadFixture(contractFixture)

      await expect(contract.connect(user).pause()).to.be.rejected
    })
  })

  describe("Freezing", function () {
    it("Should freeze and unfreeze", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)

      await contract.connect(defaultAdmin).freeze(user.address)
      expect(await contract.frozen(user.address)).to.be.true

      await contract.connect(defaultAdmin).unfreeze(user.address)
      expect(await contract.frozen(user.address)).to.be.false
    })

    it("Should not freeze if not FREEZER_ROLE", async function () {
      const { contract, user } = await loadFixture(contractFixture)

      await expect(contract.connect(user).freeze(user.address)).to.be.rejected
    })
  })

  // v3 removed the role-based gates on IDRP (no MINTER/PAUSER/FREEZER roles).
  // Authority management is exercised by the V3-* migration tests and by the
  // Controller's ACDAR tests, not here.

  describe("Minting", function () {
    it("Should mint tokens", async function () {
      const { contract, defaultAdmin, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(amount)
      expect(await contract.balanceOf(depository.address)).to.equal(amount)
    })

    it("Should burn tokens", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint tokens (goes to depository wallet)
      await contract.connect(defaultAdmin).mint(amount)

      // Transfer from depository to user
      await contract.connect(depository).transfer(user.address, amount)

      // User set allowance for defaultAdmin to be burned
      await contract.connect(user).approve(await defaultAdmin.getAddress(), amount)

      // Burn tokens from user
      await contract.connect(defaultAdmin).burn(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(0)
    })

    it("Should not mint tokens if not MINTER_ROLE", async function () {
      const { contract, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await expect(contract.connect(user).mint(amount)).to.be.rejected
    })

    it("Should not burn tokens if not MINTER_ROLE", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint and transfer to user
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(depository).transfer(user.address, amount)

      await expect(contract.connect(user).burn(user.address, amount)).to.be.rejected
    })

    it("Should not burn tokens if minter role doesn't have allowance", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint and transfer to user
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(depository).transfer(user.address, amount)

      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.revertedWith(
        "Burn amount exceeds allowance"
      )
    })

    it("Should not mint tokens if paused", async function () {
      const { contract, defaultAdmin } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).mint(amount)).to.be.rejected
    })

    it("Should not burn tokens if paused", async function () {
      const { contract, defaultAdmin, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).burn(depository.address, amount)).to.be.rejected
    })

    it("Should not mint tokens to frozen depository wallet", async function () {
      const { contract, defaultAdmin, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).freeze(depository.address)
      await expect(contract.connect(defaultAdmin).mint(amount)).to.be.rejected
    })

    it("Should not burn tokens from frozen account", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint and transfer to user
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(depository).transfer(user.address, amount)

      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.rejected
    })
  })

  describe("Transfers", function () {
    it("Should transfer tokens", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint (goes to depository) then transfer to user
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(depository).transfer(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(amount)
    })

    it("Should not transfer tokens if paused", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(depository).transfer(user.address, amount)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(user).transfer(depository.address, amount)).to.be.rejected
    })

    it("Should not transfer tokens from frozen account", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(depository).transfer(user.address, amount)
      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(user).transfer(depository.address, amount)).to.be.rejected
    })

    it("Should not transfer tokens to frozen account", async function () {
      const { contract, defaultAdmin, user, depository } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(depository).transfer(user.address, amount)).to.be.rejected
    })
  })
})

import hre from "hardhat"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { parseUnits } from "ethers"

describe("IDRP", function () {
  async function contractFixture() {
    const [defaultAdmin, user] = await hre.ethers.getSigners()
    const IDRP = await hre.ethers.getContractFactory("IDRP")
    const contract = await hre.upgrades.deployProxy(IDRP, [await defaultAdmin.getAddress()])
    await contract.waitForDeployment()

    return { contract, defaultAdmin, user }
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

  describe("Role management", function () {
    it("Should grant and revoke roles", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)

      await contract.connect(defaultAdmin).grantRole(await contract.MINTER_ROLE(), user.address)
      expect(await contract.hasRole(await contract.MINTER_ROLE(), user.address)).to.be.true

      await contract.connect(defaultAdmin).revokeRole(await contract.MINTER_ROLE(), user.address)
      expect(await contract.hasRole(await contract.MINTER_ROLE(), user.address)).to.be.false
    })
  })

  describe("Minting", function () {
    it("Should mint tokens", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(amount)
    })

    it("Should burn tokens", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint tokens to user
      await contract.connect(defaultAdmin).mint(user.address, amount)

      // User set allowance for defaultAdmin to be burned
      await contract.connect(user).approve(await defaultAdmin.getAddress(), amount)

      // Burn tokens from user
      await contract.connect(defaultAdmin).burn(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(0)
    })

    it("Should not mint tokens if not MINTER_ROLE", async function () {
      const { contract, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await expect(contract.connect(user).mint(user.address, amount)).to.be.rejected
    })

    it("Should not burn tokens if not MINTER_ROLE", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(user.address, amount)
      await expect(contract.connect(user).burn(user.address, amount)).to.be.rejected
    })

    it("Should not burn tokens if minter role doesn't have allowance", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(user.address, amount)

      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.revertedWith(
        "Burn amount exceeds allowance"
      )
    })

    it("Should not mint tokens if paused", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).mint(user.address, amount)).to.be.rejected
    })

    it("Should not burn tokens if paused", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(user.address, amount)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.rejected
    })

    it("Should not mint tokens to frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(defaultAdmin).mint(user.address, amount)).to.be.rejected
    })

    it("Should not burn tokens from frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(user.address, amount)
      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.rejected
    })
  })

  describe("Transfers", function () {
    it("Should transfer tokens", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(defaultAdmin.address, amount)
      await contract.connect(defaultAdmin).transfer(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(amount)
    })

    it("Should not transfer tokens if paused", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(defaultAdmin.address, amount)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).transfer(user.address, amount)).to.be.rejected
    })

    it("Should not transfer tokens from frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(defaultAdmin.address, amount)
      await contract.connect(defaultAdmin).freeze(defaultAdmin.address)
      await expect(contract.connect(defaultAdmin).transfer(user.address, amount)).to.be.rejected
    })

    it("Should not transfer tokens to frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).mint(defaultAdmin.address, amount)
      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(defaultAdmin).transfer(user.address, amount)).to.be.rejected
    })
  })
})

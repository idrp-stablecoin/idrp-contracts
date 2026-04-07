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

    // Set defaultAdmin as the controller so it can call mint/burn/pause/freeze etc.
    await contract.connect(defaultAdmin).setController(defaultAdmin.address)

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

    it("Should not pause if not controller", async function () {
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

    it("Should not freeze if not controller", async function () {
      const { contract, user } = await loadFixture(contractFixture)

      await expect(contract.connect(user).freeze(user.address)).to.be.rejected
    })
  })

  describe("Role management", function () {
    it("Should set and change controller", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)

      await contract.connect(defaultAdmin).setController(user.address)
      expect(await contract.controller()).to.equal(user.address)

      await contract.connect(defaultAdmin).setController(defaultAdmin.address)
      expect(await contract.controller()).to.not.equal(user.address)
    })
  })

  describe("Minting", function () {
    it("Should mint tokens", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Set depository wallet to defaultAdmin for testing
      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      expect(await contract.balanceOf(defaultAdmin.address)).to.equal(amount)
    })

    it("Should burn tokens", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      // Mint tokens to depository (defaultAdmin)
      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)

      // Transfer to user then burn from user
      await contract.connect(defaultAdmin).transfer(user.address, amount)

      // User set allowance for defaultAdmin to be burned
      await contract.connect(user).approve(await defaultAdmin.getAddress(), amount)

      // Burn tokens from user
      await contract.connect(defaultAdmin).burn(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(0)
    })

    it("Should not mint tokens if not controller", async function () {
      const { contract, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await expect(contract.connect(user).mint(amount)).to.be.rejected
    })

    it("Should not burn tokens if not controller", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).transfer(user.address, amount)
      await expect(contract.connect(user).burn(user.address, amount)).to.be.rejected
    })

    it("Should not burn tokens if controller doesn't have allowance", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).transfer(user.address, amount)

      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.revertedWith(
        "Burn amount exceeds allowance"
      )
    })

    it("Should not mint tokens if paused", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).mint(amount)).to.be.rejected
    })

    it("Should not burn tokens if paused", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).transfer(user.address, amount)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.rejected
    })

    it("Should not mint tokens to frozen depository", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).freeze(defaultAdmin.address)
      await expect(contract.connect(defaultAdmin).mint(amount)).to.be.rejected
    })

    it("Should not burn tokens from frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).transfer(user.address, amount)
      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(defaultAdmin).burn(user.address, amount)).to.be.rejected
    })
  })

  describe("Transfers", function () {
    it("Should transfer tokens", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).transfer(user.address, amount)
      expect(await contract.balanceOf(user.address)).to.equal(amount)
    })

    it("Should not transfer tokens if paused", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).pause()
      await expect(contract.connect(defaultAdmin).transfer(user.address, amount)).to.be.rejected
    })

    it("Should not transfer tokens from frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).freeze(defaultAdmin.address)
      await expect(contract.connect(defaultAdmin).transfer(user.address, amount)).to.be.rejected
    })

    it("Should not transfer tokens to frozen account", async function () {
      const { contract, defaultAdmin, user } = await loadFixture(contractFixture)
      const amount = parseUnits("1000000000", 6)

      await contract.connect(defaultAdmin).setDepositoryWallet(defaultAdmin.address)
      await contract.connect(defaultAdmin).mint(amount)
      await contract.connect(defaultAdmin).freeze(user.address)
      await expect(contract.connect(defaultAdmin).transfer(user.address, amount)).to.be.rejected
    })
  })
})

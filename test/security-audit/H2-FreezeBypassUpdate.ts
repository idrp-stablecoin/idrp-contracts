import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { parseUnits } from "ethers";

describe("[H-2] Freeze Check Bypass via _update Internal", function () {
  async function deployFixture() {
    const [admin, user, recipient, depository] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address);

    const amount = parseUnits("1000000", 6);

    return { idrp, admin, user, recipient, depository, amount };
  }

  describe("Freeze enforcement in _update", function () {
    it("Should block transfer from frozen sender", async function () {
      const { idrp, admin, user, recipient, amount } =
        await loadFixture(deployFixture);

      await idrp.connect(admin).mint(amount);
      const depository = await idrp.depositoryWallet();
      const depositSigner = await hre.ethers.getSigner(depository);

      // Transfer to user first
      await idrp.connect(depositSigner).transfer(user.address, amount);

      // Freeze user
      await idrp.connect(admin).freeze(user.address);

      // Transfer from frozen user should fail
      await expect(
        idrp.connect(user).transfer(recipient.address, amount)
      ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    });

    it("Should block transfer to frozen recipient", async function () {
      const { idrp, admin, user, recipient, amount } =
        await loadFixture(deployFixture);

      await idrp.connect(admin).mint(amount);
      const depository = await idrp.depositoryWallet();
      const depositSigner = await hre.ethers.getSigner(depository);

      await idrp.connect(depositSigner).transfer(user.address, amount);

      // Freeze recipient
      await idrp.connect(admin).freeze(recipient.address);

      // Transfer to frozen recipient should fail
      await expect(
        idrp.connect(user).transfer(recipient.address, amount)
      ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    });

    it("Should block transferFrom involving frozen account", async function () {
      const { idrp, admin, user, recipient, amount } =
        await loadFixture(deployFixture);

      await idrp.connect(admin).mint(amount);
      const depository = await idrp.depositoryWallet();
      const depositSigner = await hre.ethers.getSigner(depository);

      await idrp.connect(depositSigner).transfer(user.address, amount);
      await idrp.connect(user).approve(admin.address, amount);

      // Freeze user
      await idrp.connect(admin).freeze(user.address);

      // transferFrom frozen user should fail
      await expect(
        idrp
          .connect(admin)
          .transferFrom(user.address, recipient.address, amount)
      ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    });

    it("Should block zero amount transfers", async function () {
      const { idrp, admin, user, recipient, amount } =
        await loadFixture(deployFixture);

      await idrp.connect(admin).mint(amount);
      const depository = await idrp.depositoryWallet();
      const depositSigner = await hre.ethers.getSigner(depository);
      await idrp.connect(depositSigner).transfer(user.address, amount);

      await expect(
        idrp.connect(user).transfer(recipient.address, 0)
      ).to.be.revertedWith("Transfer amount must be greater than zero");
    });

    it("Should allow mint to frozen depository to revert via mint() check", async function () {
      const { idrp, admin, depository, amount } =
        await loadFixture(deployFixture);

      // Freeze depository
      await idrp.connect(admin).freeze(depository.address);

      // Mint should revert via the explicit check in mint()
      await expect(
        idrp.connect(admin).mint(amount)
      ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    });

    it("Should allow burn from frozen account to revert via burn() check", async function () {
      const { idrp, admin, user, amount } = await loadFixture(deployFixture);

      await idrp.connect(admin).mint(amount);
      const depository = await idrp.depositoryWallet();
      const depositSigner = await hre.ethers.getSigner(depository);
      await idrp.connect(depositSigner).transfer(user.address, amount);

      // Freeze user
      await idrp.connect(admin).freeze(user.address);

      // Burn from frozen user should revert via burn() check
      await expect(
        idrp.connect(admin).burn(user.address, amount)
      ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    });
  });

  describe("Normal operations still work", function () {
    it("Should allow transfer between unfrozen accounts", async function () {
      const { idrp, admin, user, recipient, amount } =
        await loadFixture(deployFixture);

      await idrp.connect(admin).mint(amount);
      const depository = await idrp.depositoryWallet();
      const depositSigner = await hre.ethers.getSigner(depository);
      await idrp.connect(depositSigner).transfer(user.address, amount);

      await expect(idrp.connect(user).transfer(recipient.address, amount)).to
        .not.be.reverted;
      expect(await idrp.balanceOf(recipient.address)).to.equal(amount);
    });

    it("Should allow mint and burn for unfrozen accounts", async function () {
      const { idrp, admin, depository, amount } =
        await loadFixture(deployFixture);

      // Mint
      await expect(idrp.connect(admin).mint(amount)).to.not.be.reverted;
      expect(await idrp.balanceOf(depository.address)).to.equal(amount);

      // Burn from depository
      await expect(idrp.connect(admin).burn(depository.address, amount)).to.not
        .be.reverted;
      expect(await idrp.balanceOf(depository.address)).to.equal(0);
    });
  });
});

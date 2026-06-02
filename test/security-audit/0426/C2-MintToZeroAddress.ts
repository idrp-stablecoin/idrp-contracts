import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { parseUnits } from "ethers";

describe("[C-2] Mint to address(0) When Depository Wallet Not Set", function () {
  async function deployFixture() {
    const [admin, user, depository] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    await idrp.connect(admin).grantRole(await idrp.MINTER_ROLE(), admin.address);

    const amount = parseUnits("1000000", 6); // 1M IDRP

    return { idrp, admin, user, depository, amount };
  }

  it("Should revert mint when depositoryWallet is not set", async function () {
    const { idrp, admin, amount } = await loadFixture(deployFixture);

    // depositoryWallet defaults to address(0) after deploy
    expect(await idrp.depositoryWallet()).to.equal(hre.ethers.ZeroAddress);

    await expect(
      idrp.connect(admin).mint(amount)
    ).to.be.revertedWith("Depository wallet not set");
  });

  it("Should succeed mint after depositoryWallet is set", async function () {
    const { idrp, admin, depository, amount } =
      await loadFixture(deployFixture);

    // Set depository wallet
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    expect(await idrp.depositoryWallet()).to.equal(depository.address);

    // Mint should succeed
    await expect(idrp.connect(admin).mint(amount)).to.not.be.reverted;
    expect(await idrp.balanceOf(depository.address)).to.equal(amount);
  });

  it("Should revert setDepositoryWallet with address(0)", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);

    await expect(
      idrp.connect(admin).setDepositoryWallet(hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid wallet address");
  });

  it("Should mint to correct depositoryWallet address", async function () {
    const { idrp, admin, depository, amount } =
      await loadFixture(deployFixture);

    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).mint(amount);

    // Tokens should be at depositoryWallet, not address(0)
    expect(await idrp.balanceOf(depository.address)).to.equal(amount);
    expect(await idrp.totalSupply()).to.equal(amount);
  });
});

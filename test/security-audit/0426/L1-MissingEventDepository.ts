import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("[L-1] Missing Event in setDepositoryWallet", function () {
  async function deployFixture() {
    const [admin, wallet1, wallet2] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    return { idrp, admin, wallet1, wallet2 };
  }

  it("Should emit DepositoryWalletUpdated on first set", async function () {
    const { idrp, admin, wallet1 } = await loadFixture(deployFixture);

    await expect(idrp.connect(admin).setDepositoryWallet(wallet1.address))
      .to.emit(idrp, "DepositoryWalletUpdated")
      .withArgs(hre.ethers.ZeroAddress, wallet1.address);
  });

  it("Should emit DepositoryWalletUpdated with old and new wallet", async function () {
    const { idrp, admin, wallet1, wallet2 } = await loadFixture(deployFixture);

    await idrp.connect(admin).setDepositoryWallet(wallet1.address);

    await expect(idrp.connect(admin).setDepositoryWallet(wallet2.address))
      .to.emit(idrp, "DepositoryWalletUpdated")
      .withArgs(wallet1.address, wallet2.address);
  });

  it("Should still reject address(0)", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);

    await expect(
      idrp.connect(admin).setDepositoryWallet(hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid wallet address");
  });
});

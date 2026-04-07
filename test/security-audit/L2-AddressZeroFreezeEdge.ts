import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { parseUnits } from "ethers";

describe("[L-2] address(0) Freeze Edge Case", function () {
  async function deployFixture() {
    const [admin, depository] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setController(admin.address);

    return { idrp, admin, depository };
  }

  it("Should give 'Depository wallet not set' error, not FrozenAccount, when wallet unset", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);

    // depositoryWallet is address(0), and frozen[address(0)] is false by default
    // C-2 fix ensures we get the correct error message
    await expect(
      idrp.connect(admin).mint(parseUnits("1000", 6))
    ).to.be.revertedWith("Depository wallet not set");
  });

  it("Should give 'Depository wallet not set' even if address(0) is somehow frozen", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);

    // Freeze address(0) — the check for depositoryWallet != address(0) runs BEFORE freeze check
    await idrp.connect(admin).freeze(hre.ethers.ZeroAddress);

    await expect(
      idrp.connect(admin).mint(parseUnits("1000", 6))
    ).to.be.revertedWith("Depository wallet not set");
  });

  it("Should work normally after setting valid depository wallet", async function () {
    const { idrp, admin, depository } = await loadFixture(deployFixture);

    await idrp.connect(admin).setDepositoryWallet(depository.address);

    await expect(
      idrp.connect(admin).mint(parseUnits("1000", 6))
    ).to.not.be.reverted;
  });
});

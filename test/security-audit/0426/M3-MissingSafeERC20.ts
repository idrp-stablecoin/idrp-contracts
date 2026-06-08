import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { parseUnits } from "ethers";

describe("[M-3] Missing SafeERC20 in IDRP.sol withdrawToken", function () {
  async function deployFixture() {
    const [admin, recipient, depository] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    // Deploy a mock ERC-20 token to use as the "stuck" token
    const MockFactory = await hre.ethers.getContractFactory("IDRP");
    const mockToken = await hre.upgrades.deployProxy(MockFactory, [
      admin.address,
    ]);
    await mockToken.waitForDeployment();
    await mockToken.connect(admin).setController(admin.address);
    await mockToken.connect(admin).setDepositoryWallet(admin.address);

    const amount = parseUnits("1000", 6);

    // Mint mock tokens and send to IDRP contract
    await mockToken.connect(admin).mint(amount);
    await mockToken
      .connect(admin)
      .transfer(await idrp.getAddress(), amount);

    return { idrp, mockToken, admin, recipient, amount };
  }

  it("Should withdraw stuck tokens using safeTransfer", async function () {
    const { idrp, mockToken, admin, recipient, amount } =
      await loadFixture(deployFixture);

    // Verify tokens are stuck in IDRP contract
    expect(await mockToken.balanceOf(await idrp.getAddress())).to.equal(amount);

    // Withdraw
    await expect(
      idrp
        .connect(admin)
        .withdrawToken(
          await mockToken.getAddress(),
          recipient.address,
          amount
        )
    ).to.not.be.reverted;

    expect(await mockToken.balanceOf(recipient.address)).to.equal(amount);
    expect(await mockToken.balanceOf(await idrp.getAddress())).to.equal(0);
  });

  it("Should revert withdrawal of IDRP token itself", async function () {
    const { idrp, admin, recipient } = await loadFixture(deployFixture);

    await expect(
      idrp
        .connect(admin)
        .withdrawToken(await idrp.getAddress(), recipient.address, 1000)
    ).to.be.revertedWith("Cannot withdraw IDRP token");
  });

  it("Should revert if caller is not admin", async function () {
    const { idrp, mockToken, recipient } = await loadFixture(deployFixture);

    await expect(
      idrp
        .connect(recipient)
        .withdrawToken(await mockToken.getAddress(), recipient.address, 1000)
    ).to.be.reverted;
  });
});

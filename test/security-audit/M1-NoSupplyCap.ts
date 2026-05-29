import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { parseUnits } from "ethers";

describe("[M-1] No Maximum Supply Cap", function () {
  async function deployFixture() {
    const [admin, depository] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).grantRole(await idrp.MINTER_ROLE(), admin.address);
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    return { idrp, admin, depository };
  }

  it("Should allow unlimited mint when maxSupply is 0 (default)", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);
    expect(await idrp.maxSupply()).to.equal(0);

    const largeAmount = parseUnits("999999999999", 6);
    await expect(idrp.connect(admin).mint(largeAmount)).to.not.be.reverted;
  });

  it("Should revert mint when exceeding maxSupply", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);
    const cap = parseUnits("1000000000", 6); // 1B

    await idrp.connect(admin).setMaxSupply(cap);
    expect(await idrp.maxSupply()).to.equal(cap);

    // Mint up to cap should work
    await expect(idrp.connect(admin).mint(cap)).to.not.be.reverted;

    // Mint 1 more should fail
    await expect(idrp.connect(admin).mint(1)).to.be.revertedWith(
      "Exceeds max supply"
    );
  });

  it("Should allow mint up to exact maxSupply", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);
    const cap = parseUnits("500000000", 6);

    await idrp.connect(admin).setMaxSupply(cap);
    await expect(idrp.connect(admin).mint(cap)).to.not.be.reverted;
    expect(await idrp.totalSupply()).to.equal(cap);
  });

  it("Should emit MaxSupplyUpdated event", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);
    const cap = parseUnits("1000000000", 6);

    await expect(idrp.connect(admin).setMaxSupply(cap))
      .to.emit(idrp, "MaxSupplyUpdated")
      .withArgs(0, cap);
  });

  it("Should only allow admin to set maxSupply", async function () {
    const { idrp, depository } = await loadFixture(deployFixture);

    await expect(
      idrp.connect(depository).setMaxSupply(parseUnits("1000000000", 6))
    ).to.be.reverted;
  });

  it("Should allow setting maxSupply back to 0 (unlimited)", async function () {
    const { idrp, admin } = await loadFixture(deployFixture);
    const cap = parseUnits("1000000000", 6);

    await idrp.connect(admin).setMaxSupply(cap);
    await idrp.connect(admin).setMaxSupply(0);

    const largeAmount = parseUnits("999999999999", 6);
    await expect(idrp.connect(admin).mint(largeAmount)).to.not.be.reverted;
  });
});

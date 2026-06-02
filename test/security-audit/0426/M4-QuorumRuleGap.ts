import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("[M-4] Quorum Rule Gap — No Catch-All Rule", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));

  enum OperationType { Mint, Burn, Freeze, Unfreeze, Pause, Unpause }

  async function deployFixture() {
    const [admin] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controller.waitForDeployment();

    return { controller, admin };
  }

  it("Should accept valid contiguous rules", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 0, maxAmount: 1000, requiredRoles: [OFFICER_ROLE] },
      { minAmount: 1000, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE, MANAGER_ROLE] },
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, rules)
    ).to.not.be.reverted;
  });

  it("Should reject rules with gap between ranges", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 0, maxAmount: 1000, requiredRoles: [OFFICER_ROLE] },
      { minAmount: 2000, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE, MANAGER_ROLE] }, // gap: 1000-2000
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, rules)
    ).to.be.revertedWith("Gap between rules");
  });

  it("Should reject rules not starting at 0", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 100, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE] },
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, rules)
    ).to.be.revertedWith("First rule must start at 0");
  });

  it("Should reject rules not covering max amount", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 0, maxAmount: 1000, requiredRoles: [OFFICER_ROLE] },
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, rules)
    ).to.be.revertedWith("Last rule must cover max amount");
  });

  it("Should reject empty rules", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, [])
    ).to.be.revertedWith("Rules cannot be empty");
  });

  it("Should reject invalid range (min >= max)", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 1000, maxAmount: 1000, requiredRoles: [OFFICER_ROLE] },
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, rules)
    ).to.be.revertedWith("Invalid range");
  });
});

import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("[M-6] Insufficient On-Chain Audit Log for TAP Changes", function () {
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

  it("Should emit QuorumRulesUpdated with rulesCount and updatedBy", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 0, maxAmount: 1000, requiredRoles: [OFFICER_ROLE] },
      { minAmount: 1000, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE, MANAGER_ROLE] },
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Mint, rules)
    )
      .to.emit(controller, "QuorumRulesUpdated")
      .withArgs(OperationType.Mint, 2, admin.address);
  });

  it("Should emit correct rulesCount for single rule", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 0, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE] },
    ];

    await expect(
      controller.connect(admin).setQuorumRules(OperationType.Pause, rules)
    )
      .to.emit(controller, "QuorumRulesUpdated")
      .withArgs(OperationType.Pause, 1, admin.address);
  });

  it("Should emit updatedBy as the calling admin address", async function () {
    const { controller, admin } = await loadFixture(deployFixture);

    const rules = [
      { minAmount: 0, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE] },
    ];

    const tx = await controller
      .connect(admin)
      .setQuorumRules(OperationType.Freeze, rules);
    const receipt = await tx.wait();

    const event = receipt!.logs.find((log: any) => {
      try {
        return controller.interface.parseLog(log as any)?.name === "QuorumRulesUpdated";
      } catch { return false; }
    });

    const parsed = controller.interface.parseLog(event as any);
    expect(parsed!.args.updatedBy).to.equal(admin.address);
    expect(parsed!.args.rulesCount).to.equal(1);
  });
});

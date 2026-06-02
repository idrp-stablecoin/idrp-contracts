import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import rulesMintBurn from "../../utils/rules.mint.burn.v2.json";

describe("[M-5] Unbounded Operation Deadline", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));

  enum OperationType { Mint, Burn, Freeze, Unfreeze, Pause, Unpause }

  async function deployFixture() {
    const [admin, officer, manager, depository] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controller.waitForDeployment();

    const domain = {
      name: "IDRPController",
      version: "1",
      chainId: 31337,
      verifyingContract: await controller.getAddress(),
    };
    const types = {
      Operation: [
        { name: "to", type: "address" },
        { name: "operationType", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "operationIdentifier", type: "string" },
        { name: "deadline", type: "uint256" },
      ],
    };

    await idrp.connect(admin).setController(await controller.getAddress());
    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await controller.connect(admin).grantRole(MANAGER_ROLE, manager.address);

    await controller.setQuorumRules(OperationType.Mint, rulesMintBurn);

    const SEVEN_DAYS = 7 * 24 * 60 * 60;

    return { controller, officer, manager, domain, types, SEVEN_DAYS };
  }

  it("Should reject deadline more than 7 days in the future", async function () {
    const { controller, officer, manager, domain, types, SEVEN_DAYS } =
      await loadFixture(deployFixture);

    const now = await time.latest();
    const farDeadline = now + SEVEN_DAYS + 3600; // 7 days + 1 hour
    const amount = hre.ethers.parseUnits("1000000", 6);

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-M5-FAR",
      deadline: farDeadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint, hre.ethers.ZeroAddress, amount,
        "MINT-M5-FAR", farDeadline, [sig1, sig2]
      )
    ).to.be.revertedWith("Deadline too far");
  });

  it("Should accept deadline within 7 days", async function () {
    const { controller, officer, manager, domain, types, SEVEN_DAYS } =
      await loadFixture(deployFixture);

    const now = await time.latest();
    const validDeadline = now + SEVEN_DAYS - 60; // 7 days minus 1 minute
    const amount = hre.ethers.parseUnits("1000000", 6);

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-M5-OK",
      deadline: validDeadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint, hre.ethers.ZeroAddress, amount,
        "MINT-M5-OK", validDeadline, [sig1, sig2]
      )
    ).to.not.be.reverted;
  });

  it("Should still reject expired deadline", async function () {
    const { controller, officer, manager, domain, types } =
      await loadFixture(deployFixture);

    const now = await time.latest();
    const expiredDeadline = now - 1;
    const amount = hre.ethers.parseUnits("1000000", 6);

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-M5-EXPIRED",
      deadline: expiredDeadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint, hre.ethers.ZeroAddress, amount,
        "MINT-M5-EXPIRED", expiredDeadline, [sig1, sig2]
      )
    ).to.be.revertedWith("Operation expired");
  });
});

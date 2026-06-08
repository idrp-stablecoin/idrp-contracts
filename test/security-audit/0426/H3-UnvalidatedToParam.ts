import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import rulesMintBurn from "../../utils/rules.mint.burn.v2.json";
import rulesFreezeUnfreeze from "../../utils/rules.freeze.unfreeze.json";
import rulesPause from "../../utils/rules.pause.json";
import rulesUnpause from "../../utils/rules.unpause.json";

describe("[H-3] Unvalidated 'to' Parameter for Mint/Pause/Unpause", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE"));

  enum OperationType { Mint, Burn, Freeze, Unfreeze, Pause, Unpause }

  async function deployFixture() {
    const [admin, officer, manager, director, commissioner, user, depository] =
      await hre.ethers.getSigners();

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
    await controller.connect(admin).grantRole(DIRECTOR_ROLE, director.address);
    await controller.connect(admin).grantRole(COMMISSIONER_ROLE, commissioner.address);

    await controller.setQuorumRules(OperationType.Mint, rulesMintBurn);
    await controller.setQuorumRules(OperationType.Burn, rulesMintBurn);
    await controller.setQuorumRules(OperationType.Freeze, rulesFreezeUnfreeze);
    await controller.setQuorumRules(OperationType.Unfreeze, rulesFreezeUnfreeze);
    await controller.setQuorumRules(OperationType.Pause, rulesPause);
    await controller.setQuorumRules(OperationType.Unpause, rulesUnpause);

    const deadline = (await time.latest()) + 3600;

    return {
      idrp, controller, admin, officer, manager, director, commissioner,
      user, depository, domain, types, deadline,
    };
  }

  it("Should revert Mint with non-zero 'to' address", async function () {
    const { controller, officer, manager, user, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("1000000", 6);
    const message = {
      to: user.address, // should be address(0) for Mint
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-H3-1",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint, user.address, amount, "MINT-H3-1", deadline, [sig1, sig2]
      )
    ).to.be.revertedWith("Invalid 'to' for this operation");
  });

  it("Should revert Pause with non-zero 'to' address", async function () {
    const { controller, manager, director, user, domain, types, deadline } =
      await loadFixture(deployFixture);

    const message = {
      to: user.address,
      operationType: OperationType.Pause,
      amount: 0,
      operationIdentifier: "PAUSE-H3-1",
      deadline,
    };

    const sig1 = await manager.signTypedData(domain, types, message);
    const sig2 = await director.signTypedData(domain, types, message);

    await expect(
      controller.connect(manager).executeOperation(
        OperationType.Pause, user.address, 0, "PAUSE-H3-1", deadline, [sig1, sig2]
      )
    ).to.be.revertedWith("Invalid 'to' for this operation");
  });

  it("Should revert Burn with zero 'to' address", async function () {
    const { controller, officer, manager, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("1000000", 6);
    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Burn,
      amount,
      operationIdentifier: "BURN-H3-1",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Burn, hre.ethers.ZeroAddress, amount, "BURN-H3-1", deadline, [sig1, sig2]
      )
    ).to.be.revertedWith("Invalid target address");
  });

  it("Should revert Freeze with zero 'to' address", async function () {
    const { controller, officer, domain, types, deadline } =
      await loadFixture(deployFixture);

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Freeze,
      amount: 0,
      operationIdentifier: "FREEZE-H3-1",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Freeze, hre.ethers.ZeroAddress, 0, "FREEZE-H3-1", deadline, [sig1]
      )
    ).to.be.revertedWith("Invalid target address");
  });

  it("Should allow Mint with zero 'to' address", async function () {
    const { controller, officer, manager, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("1000000", 6);
    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-H3-OK",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint, hre.ethers.ZeroAddress, amount, "MINT-H3-OK", deadline, [sig1, sig2]
      )
    ).to.not.be.reverted;
  });
});

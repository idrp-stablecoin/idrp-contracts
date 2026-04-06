import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import rulesPause from "../utils/rules.pause.json";
import rulesUnpause from "../utils/rules.unpause.json";

describe("[L-3] Duplicate Signer in verifyUnpauseSignatures", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE"));

  enum OperationType { Mint, Burn, Freeze, Unfreeze, Pause, Unpause }

  async function deployFixture() {
    const [admin, officer, manager, director, commissioner, dualRoleUser] =
      await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

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

    await controller.grantRole(OFFICER_ROLE, officer.address);
    await controller.grantRole(MANAGER_ROLE, manager.address);
    await controller.grantRole(DIRECTOR_ROLE, director.address);
    await controller.grantRole(COMMISSIONER_ROLE, commissioner.address);

    // dualRoleUser has Officer + Manager + Director roles
    await controller.grantRole(OFFICER_ROLE, dualRoleUser.address);
    await controller.grantRole(MANAGER_ROLE, dualRoleUser.address);
    await controller.grantRole(DIRECTOR_ROLE, dualRoleUser.address);

    await idrp.grantRole(await idrp.PAUSER_ROLE(), controller.getAddress());
    await controller.setQuorumRules(OperationType.Pause, rulesPause);
    await controller.setQuorumRules(OperationType.Unpause, rulesUnpause);

    const deadline = Math.floor(Date.now() / 1000) + 3600;

    return {
      idrp, controller, admin, officer, manager, director, commissioner,
      dualRoleUser, domain, types, deadline,
    };
  }

  async function pauseContract(fixture: any) {
    const { controller, manager, director, domain, types, deadline } = fixture;
    const msg = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Pause,
      amount: 0,
      operationIdentifier: "PAUSE-L3",
      deadline,
    };
    const sig1 = await manager.signTypedData(domain, types, msg);
    const sig2 = await director.signTypedData(domain, types, msg);
    await controller.connect(manager).executeOperation(
      OperationType.Pause, hre.ethers.ZeroAddress, 0, "PAUSE-L3", deadline, [sig1, sig2]
    );
  }

  it("Should reject single signer with multiple roles trying to unpause", async function () {
    const fixture = await loadFixture(deployFixture);
    await pauseContract(fixture);
    const { controller, dualRoleUser, domain, types, deadline } = fixture;

    const msg = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Unpause,
      amount: 0,
      operationIdentifier: "UNPAUSE-L3-1",
      deadline,
    };

    // dualRoleUser signs once — has Officer+Manager+Director but counts as 1 signer
    const sig = await dualRoleUser.signTypedData(domain, types, msg);

    await expect(
      controller.connect(dualRoleUser).executeOperation(
        OperationType.Unpause, hre.ethers.ZeroAddress, 0,
        "UNPAUSE-L3-1", deadline, [sig]
      )
    ).to.be.revertedWith("Invalid signature combination for unpause");
  });

  it("Should reject same signature submitted multiple times", async function () {
    const fixture = await loadFixture(deployFixture);
    await pauseContract(fixture);
    const { controller, dualRoleUser, domain, types, deadline } = fixture;

    const msg = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Unpause,
      amount: 0,
      operationIdentifier: "UNPAUSE-L3-2",
      deadline,
    };

    const sig = await dualRoleUser.signTypedData(domain, types, msg);

    // Submit same sig 3 times to try to satisfy officer+manager+director
    await expect(
      controller.connect(dualRoleUser).executeOperation(
        OperationType.Unpause, hre.ethers.ZeroAddress, 0,
        "UNPAUSE-L3-2", deadline, [sig, sig, sig]
      )
    ).to.be.revertedWith("Invalid signature combination for unpause");
  });

  it("Should succeed with 3 distinct signers for unpause", async function () {
    const fixture = await loadFixture(deployFixture);
    await pauseContract(fixture);
    const { controller, officer, manager, director, domain, types, deadline } = fixture;

    const msg = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Unpause,
      amount: 0,
      operationIdentifier: "UNPAUSE-L3-OK",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, msg);
    const sig2 = await manager.signTypedData(domain, types, msg);
    const sig3 = await director.signTypedData(domain, types, msg);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Unpause, hre.ethers.ZeroAddress, 0,
        "UNPAUSE-L3-OK", deadline, [sig1, sig2, sig3]
      )
    ).to.not.be.reverted;
  });
});

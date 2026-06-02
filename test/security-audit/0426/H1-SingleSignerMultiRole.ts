import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import rulesMintBurn from "../../utils/rules.mint.burn.v2.json";

describe("[H-1] Single Signer Can Satisfy Multiple Required Roles", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("MANAGER_ROLE")
  );
  const DIRECTOR_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("DIRECTOR_ROLE")
  );
  const COMMISSIONER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE")
  );

  const FIVE_HUNDRED_MILLION = hre.ethers.parseUnits("500000000", 6);

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  async function deployFixture() {
    const [admin, officer, manager, director, commissioner, depository, dualRoleUser] =
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

    // v3: wire IDRP -> Controller.
    await idrp.connect(admin).setController(await controller.getAddress());

    // Setup signer roles.
    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);
    await controller.connect(admin).grantRole(MANAGER_ROLE, manager.address);
    await controller.connect(admin).grantRole(DIRECTOR_ROLE, director.address);
    await controller.connect(admin).grantRole(COMMISSIONER_ROLE, commissioner.address);

    // Grant dualRoleUser BOTH officer and manager roles
    await controller.connect(admin).grantRole(OFFICER_ROLE, dualRoleUser.address);
    await controller.connect(admin).grantRole(MANAGER_ROLE, dualRoleUser.address);

    // Set quorum rules — mint 500M-1B requires Officer + Manager + Director
    await controller.setQuorumRules(OperationType.Mint, rulesMintBurn);

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      director,
      commissioner,
      depository,
      dualRoleUser,
      domain,
      types,
    };
  }

  it("Should reject when one signer tries to satisfy two roles", async function () {
    const { controller, dualRoleUser, director, domain, types } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amount = FIVE_HUNDRED_MILLION; // Requires Officer + Manager + Director

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: amount,
      operationIdentifier: "MINT-H1-TEST-1",
      deadline: deadline,
    };

    // dualRoleUser signs once (has both OFFICER_ROLE and MANAGER_ROLE)
    const dualSig = await dualRoleUser.signTypedData(domain, types, message);
    // director signs
    const directorSig = await director.signTypedData(domain, types, message);

    // Only 2 unique signers but 3 roles required — should fail
    let reverted = false;
    try {
      await controller.connect(dualRoleUser).executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        "MINT-H1-TEST-1",
        deadline,
        [dualSig, directorSig]
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });

  it("Should succeed with distinct signers for each role", async function () {
    const { controller, officer, manager, director, domain, types } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amount = FIVE_HUNDRED_MILLION; // Requires Officer + Manager + Director

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: amount,
      operationIdentifier: "MINT-H1-TEST-2",
      deadline: deadline,
    };

    // 3 distinct signers for 3 roles
    const officerSig = await officer.signTypedData(domain, types, message);
    const managerSig = await manager.signTypedData(domain, types, message);
    const directorSig = await director.signTypedData(domain, types, message);

    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        "MINT-H1-TEST-2",
        deadline,
        [officerSig, managerSig, directorSig]
      )
    ).to.not.be.reverted;
  });

  it("Should reject duplicate signatures from same signer", async function () {
    const { controller, officer, manager, domain, types } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amount = hre.ethers.parseUnits("100000000", 6); // 100M — requires Officer + Manager

    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: amount,
      operationIdentifier: "MINT-H1-TEST-3",
      deadline: deadline,
    };

    // officer signs, but submits signature twice to try to satisfy both Officer + Manager
    const officerSig = await officer.signTypedData(domain, types, message);

    let reverted = false;
    try {
      await controller.connect(officer).executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        "MINT-H1-TEST-3",
        deadline,
        [officerSig, officerSig]
      );
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
  });
});

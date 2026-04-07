import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import rulesMintBurn from "../utils/rules.mint.burn.v2.json";

describe("[M-2] Deprecated Nonce Still Being Incremented", function () {
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

    await controller.setOfficer(officer.address);
    await controller.setManager(manager.address);
    await idrp.setController(await controller.getAddress());

    await controller.setQuorumRules(OperationType.Mint, rulesMintBurn);

    return { idrp, controller, admin, officer, manager, domain, types };
  }

  it("Should not increment nonce after executeOperation", async function () {
    const { controller, officer, manager, domain, types } =
      await loadFixture(deployFixture);

    const nonceBefore = await controller.nonce();

    const deadline = (await time.latest()) + 3600;
    const amount = hre.ethers.parseUnits("1000000", 6);
    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-M2-TEST",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    await controller.connect(officer).executeOperation(
      OperationType.Mint, hre.ethers.ZeroAddress, amount,
      "MINT-M2-TEST", deadline, [sig1, sig2]
    );

    const nonceAfter = await controller.nonce();
    expect(nonceAfter).to.equal(nonceBefore); // nonce should NOT change
  });

  it("Should still prevent replay via usedSignatures", async function () {
    const { controller, officer, manager, domain, types } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amount = hre.ethers.parseUnits("1000000", 6);
    const message = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "MINT-M2-REPLAY",
      deadline,
    };

    const sig1 = await officer.signTypedData(domain, types, message);
    const sig2 = await manager.signTypedData(domain, types, message);

    // First execution succeeds
    await controller.connect(officer).executeOperation(
      OperationType.Mint, hre.ethers.ZeroAddress, amount,
      "MINT-M2-REPLAY", deadline, [sig1, sig2]
    );

    // Replay with same operationIdentifier should fail
    await expect(
      controller.connect(officer).executeOperation(
        OperationType.Mint, hre.ethers.ZeroAddress, amount,
        "MINT-M2-REPLAY", deadline, [sig1, sig2]
      )
    ).to.be.revertedWith("Operation hash already used");
  });
});

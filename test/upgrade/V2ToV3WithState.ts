import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * v2 → v3 ON A PROXY THAT HAS HISTORY.
 *
 * Tron mainnet's controller is v2 and has been running: roles granted, quorum
 * rules set, operations executed. Every previous rehearsal used a fresh proxy,
 * which proves nothing about state that already exists — so this one seeds the
 * proxy first and then migrates it, asserting that nothing already there is
 * lost, moved or silently rewritten.
 *
 * The migration is executed the way mainnet will do it: scheduleUpgrade, wait
 * out the timelock, then a single upgradeToAndCall carrying initializeV3. Never
 * split — a bare upgradeTo leaves the proxy on v3 with ACDAR uninitialised.
 */
describe("Controller v2 → v3 on a proxy with state", function () {
  const ROLE = (n: string) =>
    hre.ethers.keccak256(hre.ethers.toUtf8Bytes(n));
  const OFFICER_ROLE = ROLE("OFFICER_ROLE");
  const MANAGER_ROLE = ROLE("MANAGER_ROLE");
  const DIRECTOR_ROLE = ROLE("DIRECTOR_ROLE");
  const MINTER_ROLE = ROLE("MINTER_ROLE");
  const DEFAULT_ADMIN_ROLE = hre.ethers.ZeroHash;

  const AMOUNT = hre.ethers.parseUnits("1000000", 6);

  enum Op {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  /** A v2 proxy carrying the kind of state mainnet's carries. */
  async function seededV2Fixture() {
    const [admin, officer, manager, director, depository] =
      await hre.ethers.getSigners();

    const idrp = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPv2"),
      [admin.address],
    );
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPControllerv2"),
      [await idrp.getAddress(), admin.address],
    );
    await controller.waitForDeployment();
    await idrp
      .connect(admin)
      .grantRole(MINTER_ROLE, await controller.getAddress());

    for (const [role, who] of [
      [OFFICER_ROLE, officer],
      [MANAGER_ROLE, manager],
      [DIRECTOR_ROLE, director],
    ] as const) {
      await controller.connect(admin).grantRole(role, who.address);
    }

    const anyAmount = {
      minAmount: 0,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: [OFFICER_ROLE],
    };
    await controller.connect(admin).setQuorumRules(Op.Mint, [anyAmount]);
    await controller.connect(admin).setQuorumRules(Op.Freeze, [anyAmount]);

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

    // History: one executed operation, so the proxy carries a usedSignatures
    // entry written by the OLD scheme, plus minted supply.
    const historicId = "executed-before-the-migration";
    const historicDeadline = (await time.latest()) + 3600;
    await controller.executeOperation(
      Op.Mint,
      hre.ethers.ZeroAddress,
      AMOUNT,
      historicId,
      historicDeadline,
      [
        await officer.signTypedData(domain, types, {
          to: hre.ethers.ZeroAddress,
          operationType: Op.Mint,
          amount: AMOUNT,
          operationIdentifier: historicId,
          deadline: historicDeadline,
        }),
      ],
    );

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      director,
      depository,
      domain,
      types,
      historicId,
      historicDeadline,
    };
  }

  /** Runs the migration exactly as mainnet will: schedule, wait, atomic call. */
  async function migrate(controller: any, admin: any, legacyAdmins: string[]) {
    const v3 = await hre.ethers.getContractFactory("IDRPController");
    const impl = await v3.deploy();
    await impl.waitForDeployment();
    const implAddress = await impl.getAddress();

    await controller.connect(admin).scheduleUpgrade(implAddress);
    await time.increase(48 * 60 * 60 + 1);

    const data = v3.interface.encodeFunctionData("initializeV3", [
      admin.address,
      admin.address,
      legacyAdmins,
    ]);
    await controller.connect(admin).upgradeToAndCall(implAddress, data);

    return hre.ethers.getContractAt("IDRPController", await controller.getAddress());
  }

  it("carries every piece of existing state across the migration", async function () {
    const {
      idrp,
      controller,
      admin,
      officer,
      depository,
      historicId,
      historicDeadline,
    } = await loadFixture(seededV2Fixture);

    const before = {
      token: await controller.idrpToken(),
      upgrader: await controller.upgrader(),
      officerRole: await controller.hasRole(OFFICER_ROLE, officer.address),
      quorum: await controller.getQuorumRule(Op.Mint, AMOUNT),
      historicDigest: await controller.getOperationHash(
        hre.ethers.ZeroAddress,
        Op.Mint,
        AMOUNT,
        historicId,
        historicDeadline,
      ),
      supply: await idrp.balanceOf(depository.address),
    };
    expect(await controller.usedSignatures(before.historicDigest)).to.equal(
      true,
    );

    const v3 = await migrate(controller, admin, [admin.address]);

    expect(await v3.idrpToken()).to.equal(before.token);
    expect(await v3.upgrader()).to.equal(before.upgrader);
    expect(await v3.hasRole(OFFICER_ROLE, officer.address)).to.equal(true);
    expect((await v3.getQuorumRule(Op.Mint, AMOUNT)).requiredRoles).to.deep.equal(
      before.quorum.requiredRoles,
    );
    // The pre-migration record is still there and still readable.
    expect(await v3.usedSignatures(before.historicDigest)).to.equal(true);
    expect(await idrp.balanceOf(depository.address)).to.equal(before.supply);
    // Signing is unaffected: the same inputs still hash to the same digest.
    expect(
      await v3.getOperationHash(
        hre.ethers.ZeroAddress,
        Op.Mint,
        AMOUNT,
        historicId,
        historicDeadline,
      ),
    ).to.equal(before.historicDigest);
  });

  it("revokes every legacy admin that initializeV3 is told about", async function () {
    const { controller, admin } = await loadFixture(seededV2Fixture);
    const [, , , , , second] = await hre.ethers.getSigners();

    // A second legacy admin, as a chain that granted the role twice would have.
    await controller.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, second.address);
    expect(await controller.hasRole(DEFAULT_ADMIN_ROLE, second.address)).to.equal(
      true,
    );

    const v3 = await migrate(controller, admin, [admin.address, second.address]);

    expect(await v3.defaultAdmin()).to.equal(admin.address);
    expect(await v3.hasRole(DEFAULT_ADMIN_ROLE, second.address)).to.equal(false);
  });

  it("leaves a legacy admin in place when initializeV3 is NOT told about it", async function () {
    const { controller, admin } = await loadFixture(seededV2Fixture);
    const [, , , , , omitted] = await hre.ethers.getSigners();

    await controller.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, omitted.address);

    // The list is the only thing that revokes. Omit an address and it keeps the
    // role after the migration — which is why Tron's list was enumerated from
    // the chain rather than assumed.
    const v3 = await migrate(controller, admin, [admin.address]);

    expect(await v3.hasRole(DEFAULT_ADMIN_ROLE, omitted.address)).to.equal(true);
  });

  it("brings the identifier guard with it", async function () {
    const { controller, admin, officer, domain, types } =
      await loadFixture(seededV2Fixture);

    const v3 = await migrate(controller, admin, [admin.address]);

    const id = "post-migration-operation";
    const first = (await time.latest()) + 3600;
    const sign = (deadline: number) =>
      officer.signTypedData(domain, types, {
        to: hre.ethers.ZeroAddress,
        operationType: Op.Mint,
        amount: AMOUNT,
        operationIdentifier: id,
        deadline,
      });

    await v3.executeOperation(
      Op.Mint,
      hre.ethers.ZeroAddress,
      AMOUNT,
      id,
      first,
      [await sign(first)],
    );
    await expect(
      v3.executeOperation(
        Op.Mint,
        hre.ethers.ZeroAddress,
        AMOUNT,
        id,
        first + 608,
        [await sign(first + 608)],
      ),
    ).to.be.revertedWith("Operation identifier already used");
  });

  it("can still be upgraded afterwards — the proxy is not frozen", async function () {
    const { controller, admin } = await loadFixture(seededV2Fixture);

    const v3 = await migrate(controller, admin, [admin.address]);

    // A second hop, to prove the UUPS path still authorises after ACDAR is in
    // place. Freezing here is the failure mode a storage-slot proxy check has;
    // this lineage keeps the immutable, so it should not happen.
    const next = await (await hre.ethers.getContractFactory("IDRPController")).deploy();
    await next.waitForDeployment();
    const nextAddress = await next.getAddress();

    await v3.connect(admin).scheduleUpgrade(nextAddress);
    await time.increase(48 * 60 * 60 + 1);
    await expect(v3.connect(admin).upgradeTo(nextAddress)).to.not.be.reverted;
  });
});

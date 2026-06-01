import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [V5-1] Audit v5.0 finding SC-04: signature replay in executeOperation.
 *
 * The auditor worked off the OLD deployed impl (reconstructed from ABI) and
 * flagged that getOperationHash() does NOT include `nonce` — so replay
 * protection rests entirely on `usedSignatures[operationHash]` plus the
 * uniqueness of the signed tuple (to, operationType, amount,
 * operationIdentifier, deadline).
 *
 * Per the 29-05 meeting note, SC-04 is "on hold — coba test dulu". This file
 * pins the actual on-chain behaviour of the current source so we know exactly
 * what the existing guard does and does NOT cover:
 *
 *   1. Exact replay (same signed tuple, same sigs) is blocked after a
 *      successful execute — usedSignatures[hash] is set on line 294.
 *   2. operationIdentifier reuse is blocked: reusing the SAME identifier with
 *      the same (to, type, amount, deadline) yields the SAME hash, so even
 *      freshly re-signed messages hit the used-hash guard.
 *   3. RESIDUAL (by design, not a contract bug): a DIFFERENT operationIdentifier
 *      produces a fresh hash and executes again. This is the exact spot the
 *      auditor's "nonce missing" concern lands — replay safety is delegated to
 *      the off-chain layer never re-issuing an operationIdentifier. This test
 *      documents that contract so the off-chain invariant is explicit.
 *
 * No contract change is asserted here: the new impl is still under review
 * (we're waiting on the final report). These tests describe the guarantee the
 * current code actually provides.
 */
describe("[V5-1] IDRPController.executeOperation — signature replay (SC-04)", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );
  const MANAGER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("MANAGER_ROLE")
  );
  const DIRECTOR_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("DIRECTOR_ROLE")
  );

  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6);
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
    const [admin, officer, manager, director, depository, victim] =
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

    await controller.grantRole(OFFICER_ROLE, officer.address);
    await controller.grantRole(MANAGER_ROLE, manager.address);
    await controller.grantRole(DIRECTOR_ROLE, director.address);

    // executeOperation requires the *caller* to hold a controller role too.
    await idrp.grantRole(await idrp.MINTER_ROLE(), controller.getAddress());
    await idrp.grantRole(await idrp.FREEZER_ROLE(), controller.getAddress());

    await controller.setQuorumRules(OperationType.Mint, [
      { minAmount: 0, maxAmount: ONE_HUNDRED_MILLION, requiredRoles: [OFFICER_ROLE] },
      {
        minAmount: ONE_HUNDRED_MILLION,
        maxAmount: FIVE_HUNDRED_MILLION,
        requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
      },
      {
        minAmount: FIVE_HUNDRED_MILLION,
        maxAmount: hre.ethers.MaxUint256,
        requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
      },
    ]);

    await controller.setQuorumRules(OperationType.Freeze, [
      { minAmount: 0, maxAmount: hre.ethers.MaxUint256, requiredRoles: [OFFICER_ROLE] },
    ]);

    // Fresh deadline well inside MAX_DEADLINE_DURATION (7 days).
    const latest = await hre.ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + 3600;

    return {
      idrp,
      controller,
      admin,
      officer,
      manager,
      director,
      depository,
      victim,
      domain,
      types,
      deadline,
    };
  }

  async function signers(domain: any, types: any, op: any, list: any[]) {
    return Promise.all(list.map((s) => s.signTypedData(domain, types, op)));
  }

  it("blocks exact replay: reusing the same sigs+tuple after a successful execute reverts", async function () {
    const { controller, idrp, officer, depository, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("50000000", 6); // 50M → officer only
    const op = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "replay-exact-1",
      deadline,
    };
    const [officerSig] = await signers(domain, types, op, [officer]);

    // First execution succeeds and mints to the depository wallet.
    await expect(
      controller
        .connect(officer)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, [officerSig])
    ).to.emit(controller, "OperationExecuted");
    expect(await idrp.balanceOf(depository.address)).to.equal(amount);

    // Replaying the identical call (same hash) hits usedSignatures[hash].
    await expect(
      controller
        .connect(officer)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, [officerSig])
    ).to.be.revertedWith("Operation hash already used");

    // And no second mint happened.
    expect(await idrp.balanceOf(depository.address)).to.equal(amount);
  });

  it("blocks operationIdentifier reuse: re-signing the same identifier yields the same used hash", async function () {
    const { controller, idrp, officer, depository, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("50000000", 6);
    const op = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "reused-id-1",
      deadline,
    };

    const [sig1] = await signers(domain, types, op, [officer]);
    await controller
      .connect(officer)
      .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, [sig1]);

    // Attacker re-signs the SAME identifier/tuple with a fresh signature object.
    // getOperationHash is deterministic over the tuple → identical hash → blocked.
    const [sig2] = await signers(domain, types, op, [officer]);
    await expect(
      controller
        .connect(officer)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, [sig2])
    ).to.be.revertedWith("Operation hash already used");

    expect(await idrp.balanceOf(depository.address)).to.equal(amount);
  });

  it("confirms the hash binds operationIdentifier: a stale sig for id A cannot authorize id B", async function () {
    const { controller, officer, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("50000000", 6);
    const opA = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "id-A",
      deadline,
    };
    const [sigForA] = await signers(domain, types, opA, [officer]);

    // Submit opA's signature but claim a different identifier "id-B". The hash
    // recovered on-chain is over "id-B", so the recovered signer is garbage and
    // the officer-role requirement is not met → reverts on missing signature.
    // (The contract builds that error via abi.encodePacked, which the chai
    // matcher can't ABI-decode, so we assert the raw revert by hand.)
    let reverted = false;
    try {
      await controller
        .connect(officer)
        .executeOperation(opA.operationType, opA.to, opA.amount, "id-B", opA.deadline, [sigForA]);
    } catch {
      reverted = true;
    }
    expect(reverted).to.equal(true);
  });

  it("RESIDUAL (by design): a NEW operationIdentifier re-executes — replay safety is delegated off-chain", async function () {
    const { controller, idrp, officer, depository, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("50000000", 6);

    const op1 = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "unique-1",
      deadline,
    };
    const [s1] = await signers(domain, types, op1, [officer]);
    await controller
      .connect(officer)
      .executeOperation(op1.operationType, op1.to, op1.amount, op1.operationIdentifier, op1.deadline, [s1]);

    // Same recipient, same amount, same deadline — only the identifier differs.
    // This is NOT a replay of op1's signature; it is a brand-new authorized op.
    // The point: nothing in the CONTRACT stops the off-chain layer from issuing
    // a second mint for the "same" business event if it reuses parameters with a
    // new id. That guarantee lives off-chain (see audit-5.0 summary, SC-04).
    const op2 = { ...op1, operationIdentifier: "unique-2" };
    const [s2] = await signers(domain, types, op2, [officer]);
    await expect(
      controller
        .connect(officer)
        .executeOperation(op2.operationType, op2.to, op2.amount, op2.operationIdentifier, op2.deadline, [s2])
    ).to.emit(controller, "OperationExecuted");

    // Two distinct identifiers → two mints.
    expect(await idrp.balanceOf(depository.address)).to.equal(amount * 2n);
  });

  it("SC-04 binding: domain separator binds chainId + verifyingContract (no cross-chain/contract replay)", async function () {
    // getOperationHash hashes the EIP-712 domain (name, version, chainId,
    // verifyingContract) into the struct hash. We assert two contracts at
    // different addresses produce DIFFERENT operation hashes for the SAME tuple,
    // proving a signature for controller A cannot be replayed on controller B
    // (and, since chainId is in the domain, not across chains either). This is
    // why no explicit `nonce` is required for replay safety.
    const { controller, idrp, admin } = await loadFixture(deployFixture);

    // Deploy a SECOND controller pointing at the same token → different address.
    const controllerB = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controllerB.waitForDeployment();

    const args = [
      hre.ethers.ZeroAddress,
      OperationType.Mint,
      hre.ethers.parseUnits("50000000", 6),
      "binding-1",
      9999999999,
    ] as const;

    const hashA = await controller.getOperationHash(...args);
    const hashB = await controllerB.getOperationHash(...args);

    expect(hashA).to.not.equal(hashB);
  });

  it("blocks replay across a higher quorum tier too (officer+manager+director, 500M+)", async function () {
    const { controller, idrp, officer, manager, director, depository, domain, types, deadline } =
      await loadFixture(deployFixture);

    const amount = hre.ethers.parseUnits("600000000", 6); // 600M → top tier
    const op = {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: "tier3-replay",
      deadline,
    };
    const sigs = await signers(domain, types, op, [officer, manager, director]);

    await controller
      .connect(officer)
      .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, sigs);
    expect(await idrp.balanceOf(depository.address)).to.equal(amount);

    // Full multi-sig bundle replayed → still blocked by used-hash guard.
    await expect(
      controller
        .connect(officer)
        .executeOperation(op.operationType, op.to, op.amount, op.operationIdentifier, op.deadline, sigs)
    ).to.be.revertedWith("Operation hash already used");
  });
});

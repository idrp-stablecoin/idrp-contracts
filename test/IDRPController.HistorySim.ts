import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * UPGRADE SIMULATION — what the two kinds of record look like either side of the
 * hotfix, and what the dashboard gate has to do about each.
 *
 * A proxy that has been running since before the hotfix holds history in the OLD
 * shape: usedSignatures[digest], where the digest covers the deadline. The new
 * shape, usedSignatures[keccak(identifier)], only starts appearing at the
 * upgrade. This file builds both shapes on one contract and pins down exactly
 * what each one protects.
 *
 * The pre-upgrade record is written straight into storage rather than produced by
 * running the old implementation: usedSignatures is slot 3 (compiler layout), so
 * keccak256(abi.encode(digest, 3)) is the flag for that digest. That is the same
 * state an old execution would have left, without having to keep a copy of the
 * old contract in the tree.
 */
describe("IDRPController - pre/post upgrade history simulation", function () {
  const OFFICER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("OFFICER_ROLE")
  );

  /** Slot of `usedSignatures` in IDRPController — verified against storageLayout. */
  const USED_SIGNATURES_SLOT = 3n;

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
    Pause,
    Unpause,
  }

  async function deployFixture() {
    const [admin, officer, user1, depository] = await hre.ethers.getSigners();

    const idrp = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRP"),
      [admin.address]
    );
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [await idrp.getAddress(), admin.address]
    );
    await controller.waitForDeployment();
    await idrp.connect(admin).setController(await controller.getAddress());
    await controller.connect(admin).grantRole(OFFICER_ROLE, officer.address);

    const anyAmount = {
      minAmount: 0,
      maxAmount: hre.ethers.MaxUint256,
      requiredRoles: [OFFICER_ROLE],
    };
    await controller.setQuorumRules(OperationType.Mint, [anyAmount]);

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

    return { idrp, controller, admin, officer, user1, depository, domain, types };
  }

  /** Writes the flag an execution would have left BEFORE the hotfix. */
  async function markUsedPreUpgrade(controller: any, digest: string) {
    const slot = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256"],
        [digest, USED_SIGNATURES_SLOT]
      )
    );
    await hre.network.provider.send("hardhat_setStorageAt", [
      await controller.getAddress(),
      slot,
      hre.ethers.toBeHex(1n, 32),
    ]);
  }

  /**
   * The dashboard's gate, in the order the server runs it: the identifier key
   * first, then one digest per deadline the operation has ever carried.
   */
  async function gateSaysExecuted(
    controller: any,
    op: { to: string; type: number; amount: bigint; id: string },
    deadlines: bigint[]
  ): Promise<{ executed: boolean; via?: string }> {
    if (await controller.isOperationIdentifierUsed(op.id)) {
      return { executed: true, via: "identifier" };
    }
    for (const deadline of deadlines) {
      const digest = await controller.getOperationHash(
        op.to,
        op.type,
        op.amount,
        op.id,
        deadline
      );
      if (await controller.usedSignatures(digest)) {
        return { executed: true, via: "digest" };
      }
    }
    return { executed: false };
  }

  it("old record: the chain still proves it ran, and the gate finds it", async function () {
    const { controller, domain, types, officer } = await loadFixture(
      deployFixture
    );

    const id = "legacy-operation";
    const amount = hre.ethers.parseUnits("1000000", 6);
    const oldDeadline = BigInt((await time.latest()) + 3600);

    const digest = await controller.getOperationHash(
      hre.ethers.ZeroAddress,
      OperationType.Mint,
      amount,
      id,
      oldDeadline
    );
    await markUsedPreUpgrade(controller, digest);

    // The old shape is present, the new one is not — history is NOT keyed in.
    expect(await controller.usedSignatures(digest)).to.equal(true);
    expect(await controller.isOperationIdentifierUsed(id)).to.equal(false);

    // Which is exactly why the gate exists: it finds the operation by digest.
    expect(
      await gateSaysExecuted(
        controller,
        { to: hre.ethers.ZeroAddress, type: OperationType.Mint, amount, id },
        [oldDeadline]
      )
    ).to.deep.equal({ executed: true, via: "digest" });

    // And this is the gap the gate is covering: the CONTRACT alone would let a
    // pre-upgrade identifier run once more under a new deadline. Stated as a
    // passing assertion so nobody mistakes the fix for retroactive.
    const newDeadline = oldDeadline + 600n;
    const signature = await officer.signTypedData(domain, types, {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount,
      operationIdentifier: id,
      deadline: newDeadline,
    });
    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        id,
        newDeadline,
        [signature]
      )
    ).to.not.be.reverted;
  });

  it("new record: one execution keys the identifier, and a re-open is refused", async function () {
    const { controller, officer, domain, types } = await loadFixture(
      deployFixture
    );

    const id = "post-upgrade-op";
    const amount = hre.ethers.parseUnits("1000", 6);
    const firstDeadline = BigInt((await time.latest()) + 3600);

    const sign = (deadline: bigint) =>
      officer.signTypedData(domain, types, {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount,
        operationIdentifier: id,
        deadline,
      });

    expect(await controller.isOperationIdentifierUsed(id)).to.equal(false);

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      amount,
      id,
      firstDeadline,
      [await sign(firstDeadline)]
    );

    // Both records are now present: the approval AND the operation.
    const digest = await controller.getOperationHash(
      hre.ethers.ZeroAddress,
      OperationType.Mint,
      amount,
      id,
      firstDeadline
    );
    expect(await controller.usedSignatures(digest)).to.equal(true);
    expect(await controller.isOperationIdentifierUsed(id)).to.equal(true);

    // The failing move — new deadline, fresh signature — is now refused.
    const secondDeadline = firstDeadline + 608n;
    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        amount,
        id,
        secondDeadline,
        [await sign(secondDeadline)]
      )
    ).to.be.revertedWith("Operation identifier already used");

    // The gate answers in one call now, with no arguments to get wrong.
    expect(
      await gateSaysExecuted(
        controller,
        { to: hre.ethers.ZeroAddress, type: OperationType.Mint, amount, id },
        []
      )
    ).to.deep.equal({ executed: true, via: "identifier" });
  });

  it("uniqueness is by identifier alone, not by the arguments beside it", async function () {
    const { controller, officer, domain, types } = await loadFixture(
      deployFixture
    );

    const id = "one-shot";
    const first = hre.ethers.parseUnits("500", 6);
    const second = hre.ethers.parseUnits("999", 6);
    const deadline = BigInt((await time.latest()) + 3600);

    const sign = (amount: bigint) =>
      officer.signTypedData(domain, types, {
        to: hre.ethers.ZeroAddress,
        operationType: OperationType.Mint,
        amount,
        operationIdentifier: id,
        deadline,
      });

    await controller.executeOperation(
      OperationType.Mint,
      hre.ethers.ZeroAddress,
      first,
      id,
      deadline,
      [await sign(first)]
    );

    // A corrected amount under the same identifier is still the same operation.
    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        second,
        id,
        deadline,
        [await sign(second)]
      )
    ).to.be.revertedWith("Operation identifier already used");

    // A genuinely different operation is unaffected.
    const otherId = "a-different-operation";
    const otherSig = await officer.signTypedData(domain, types, {
      to: hre.ethers.ZeroAddress,
      operationType: OperationType.Mint,
      amount: second,
      operationIdentifier: otherId,
      deadline,
    });
    await expect(
      controller.executeOperation(
        OperationType.Mint,
        hre.ethers.ZeroAddress,
        second,
        otherId,
        deadline,
        [otherSig]
      )
    ).to.not.be.reverted;
  });
});

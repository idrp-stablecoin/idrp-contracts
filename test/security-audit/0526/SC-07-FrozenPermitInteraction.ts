import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * [V5-2] Audit v5.0 finding SC-07 / SC-15: frozen accounts + permit().
 *
 * Meeting 29-05: "[SC.07] perlu cek aja _update itu udah jagain permit() belom".
 *
 * Baseline (inherited behaviour): permit() comes from ERC20PermitUpgradeable and
 * only sets an allowance via _approve(); it never routes through _update(). So
 * by default a frozen account could still emit permits / set allowances, even
 * though the eventual transferFrom is blocked in _update(). No fund-loss path,
 * but a griefing/allowance-set surface.
 *
 * audit-5.0 phase-1 fix (IDRP.permit override): we now gate permit() itself —
 * if either the owner or the spender is frozen, permit() reverts FrozenAccount.
 * This closes the surface the auditor flagged, on top of the existing _update()
 * guard (defense-in-depth: actual movement stays blocked regardless).
 *
 * This file pins BOTH layers:
 *   1. permit() reverts when owner/spender is frozen (new gate).
 *   2. transferFrom of a frozen holder reverts in _update() even if an allowance
 *      was set BEFORE the freeze (the SC-15 scenario; the deeper guarantee).
 */
describe("[0526 SC-07] IDRP — frozen account + permit() interaction", function () {
  const ONE_HUNDRED = hre.ethers.parseUnits("100", 6);

  async function deployFixture() {
    const [admin, depository, holder, spender] = await hre.ethers.getSigners();

    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();

    // v3: admin doubles as controller for direct mint/freeze in tests.
    await idrp.connect(admin).setController(admin.address);

    // Mint to depository, then move a balance to `holder` so it has real funds.
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).mint(ONE_HUNDRED * 10n);
    await idrp.connect(depository).transfer(holder.address, ONE_HUNDRED * 5n);

    const chainId = 31337;
    const permitDomain = {
      name: "IDRP",
      version: "1",
      chainId,
      verifyingContract: await idrp.getAddress(),
    };
    const permitTypes = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    async function signPermit(
      owner: any,
      spenderAddr: string,
      value: bigint,
      deadline: number
    ) {
      const nonce = await idrp.nonces(owner.address);
      const sig = await owner.signTypedData(permitDomain, permitTypes, {
        owner: owner.address,
        spender: spenderAddr,
        value,
        nonce,
        deadline,
      });
      const { v, r, s } = hre.ethers.Signature.from(sig);
      return { v, r, s };
    }

    const latest = await hre.ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + 3600;

    return { idrp, admin, depository, holder, spender, signPermit, deadline };
  }

  it("NEW GATE: frozen OWNER's permit() reverts FrozenAccount (no allowance set)", async function () {
    const { idrp, admin, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    await idrp.connect(admin).freeze(holder.address);
    expect(await idrp.frozen(holder.address)).to.be.true;

    const { v, r, s } = await signPermit(
      holder,
      spender.address,
      ONE_HUNDRED,
      deadline
    );

    // audit-5.0 phase-1 (SC-07): permit() now reverts for a frozen owner.
    await expect(
      idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, v, r, s)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");

    // No allowance was set.
    expect(await idrp.allowance(holder.address, spender.address)).to.equal(0);
  });

  it("NEW GATE: permit() reverts when the SPENDER is frozen", async function () {
    const { idrp, admin, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    await idrp.connect(admin).freeze(spender.address);

    const { v, r, s } = await signPermit(
      holder,
      spender.address,
      ONE_HUNDRED,
      deadline
    );

    await expect(
      idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, v, r, s)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("permit() still works normally when neither party is frozen", async function () {
    const { idrp, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    const { v, r, s } = await signPermit(
      holder,
      spender.address,
      ONE_HUNDRED,
      deadline
    );

    await expect(
      idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, v, r, s)
    ).to.not.be.reverted;

    expect(await idrp.allowance(holder.address, spender.address)).to.equal(
      ONE_HUNDRED
    );
  });

  it("the dangerous path is blocked: transferFrom on a frozen holder reverts despite valid allowance", async function () {
    const { idrp, admin, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    // Holder grants allowance via permit BEFORE being frozen.
    const { v, r, s } = await signPermit(
      holder,
      spender.address,
      ONE_HUNDRED,
      deadline
    );
    await idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, v, r, s);
    expect(await idrp.allowance(holder.address, spender.address)).to.equal(
      ONE_HUNDRED
    );

    // Now freeze the holder. The standing allowance is irrelevant: the actual
    // move routes through _update(), which reverts on frozen[from].
    await idrp.connect(admin).freeze(holder.address);

    await expect(
      idrp.connect(spender).transferFrom(holder.address, spender.address, ONE_HUNDRED)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");

    // No funds moved.
    expect(await idrp.balanceOf(holder.address)).to.equal(ONE_HUNDRED * 5n);
  });

  it("SC-15 scenario (deeper guard): allowance set pre-freeze, then freeze → transferFrom blocked", async function () {
    const { idrp, admin, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    // Allowance granted BEFORE freeze (the permit gate would block it after).
    const { v, r, s } = await signPermit(
      holder,
      spender.address,
      ONE_HUNDRED,
      deadline
    );
    await idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, v, r, s);
    expect(await idrp.allowance(holder.address, spender.address)).to.equal(
      ONE_HUNDRED
    );

    // Now freeze. Even with a valid standing allowance, the move is blocked in
    // _update() — this is the deeper guarantee underneath the permit() gate.
    await idrp.connect(admin).freeze(holder.address);
    await expect(
      idrp.connect(spender).transferFrom(holder.address, spender.address, ONE_HUNDRED)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("frozen RECIPIENT also blocks transferFrom (freeze guard covers both sides)", async function () {
    const { idrp, admin, depository, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    // holder approves spender to move funds to the spender, but spender is frozen.
    const { v, r, s } = await signPermit(
      holder,
      spender.address,
      ONE_HUNDRED,
      deadline
    );
    await idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, v, r, s);

    await idrp.connect(admin).freeze(spender.address);

    await expect(
      idrp.connect(spender).transferFrom(holder.address, spender.address, ONE_HUNDRED)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("after unfreeze, permit() works again and the allowance is usable", async function () {
    const { idrp, admin, holder, spender, signPermit, deadline } =
      await loadFixture(deployFixture);

    // While frozen, permit() is rejected outright.
    await idrp.connect(admin).freeze(holder.address);
    const blocked = await signPermit(holder, spender.address, ONE_HUNDRED, deadline);
    await expect(
      idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, blocked.v, blocked.r, blocked.s)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");

    // After unfreeze, permit() succeeds (nonce unchanged since the blocked call
    // reverted) and the resulting allowance is spendable.
    await idrp.connect(admin).unfreeze(holder.address);
    const ok = await signPermit(holder, spender.address, ONE_HUNDRED, deadline);
    await idrp.permit(holder.address, spender.address, ONE_HUNDRED, deadline, ok.v, ok.r, ok.s);

    await expect(
      idrp.connect(spender).transferFrom(holder.address, spender.address, ONE_HUNDRED)
    ).to.not.be.reverted;
    expect(await idrp.balanceOf(spender.address)).to.equal(ONE_HUNDRED);
  });
});

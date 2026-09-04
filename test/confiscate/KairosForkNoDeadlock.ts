import hre from "hardhat";
import { expect } from "chai";

/**
 * Kairos fork: does the confiscate→depository upgrade brick the live token?
 *
 * Kairos is the ONLY chain that ever applied the old design, so it is the only
 * one whose reserved slots are non-zero. Slot 9 holds
 * `0x…f1c508ce…c3cb` — the retired destination — and `_inConfiscation` lives at
 * byte 20 of that same word. This suite forks Kairos at head, runs the REAL
 * upgrade with the REAL upgrader against the REAL deployed bytecode, and then
 * tries to find a way to deadlock the token.
 *
 * "Deadlock" here means any of:
 *   - the freeze gate silently stops enforcing (the packed-slot hazard)
 *   - authority slots (admin / upgrader / controller / depository) are lost
 *   - balances or supply move
 *   - the token can no longer be upgraded again
 *   - a retired selector still dispatches into live code
 *
 * GATED BY ENV VAR, matching test/upgrade/MainnetForkV3Migration.ts, so a plain
 * CI run never depends on an external RPC:
 *
 *   KAIROS_FORK_RPC_URL=https://rpc.ankr.com/kaia_testnet \
 *     npx hardhat test test/confiscate/KairosForkNoDeadlock.ts
 */

const IDRP_PROXY = "0x999f947F3c7C0cF64AE53571a7fda51ce7f66164";
const CTRL_PROXY = "0x38f94bf4D2D4f4a8E9f35606071DA7A51E92D26A";
/** Live token upgrader — an EOA, and also the depository wallet on this chain. */
const UPGRADER = "0x0FC4CBd7f60E0BE5FeaCFAB6B8818F88763f9640";
/** The implementation deployed today, compiled with the 5-minute delay override. */
const DEPLOYED_IMPL = "0x70024fd470258167A9299a412205dd1fFFBF5022";
/** The retired destination Kairos applied under the old design. */
const RETIRED_DESTINATION = "0xF1c508CE6B951475F204ae2d68527c6cF995C3CB";
/** Slot 9 as it reads on the live proxy: retired address in bytes 0-19. */
const LIVE_SLOT_9 =
  "0x000000000000000000000000f1c508ce6b951475f204ae2d68527c6cf995c3cb";

describe("Kairos fork: confiscate→depository upgrade must not deadlock the token", function () {
  this.timeout(300_000);

  let originalForkConfig: unknown;
  let enabled = false;

  /** State captured before the upgrade, compared against after. */
  let pre: {
    admin: string;
    upgrader: string;
    controller: string;
    depository: string;
    totalSupply: bigint;
    depositoryBalance: bigint;
    delay: bigint;
    paused: boolean;
  };

  before(async function () {
    const rpcUrl = process.env.KAIROS_FORK_RPC_URL;
    if (!rpcUrl) {
      console.log(
        "\n  [skipping] KAIROS_FORK_RPC_URL not set. " +
          "Set it (e.g. https://rpc.ankr.com/kaia_testnet) to run the Kairos fork check."
      );
      this.skip();
    }
    enabled = true;

    originalForkConfig = (hre.network.config as { forking?: unknown }).forking;

    // Pin an explicit block a few behind head. Kaia produces ~1 block/second and
    // public nodes retain only ~100 blocks of state, so an unpinned fork can
    // land on a height one load-balanced node has and another has already
    // pruned — which surfaces as "missing trie node", not as a clear error.
    // Everything this suite needs is fetched in the first few seconds; after
    // that the run is local.
    const probe = new hre.ethers.JsonRpcProvider(rpcUrl);
    const blockNumber = (await probe.getBlockNumber()) - 5;
    probe.destroy();
    console.log(`  forking Kairos at block ${blockNumber}`);

    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: rpcUrl, blockNumber } }],
    });

    await hre.network.provider.send("hardhat_setBalance", [
      UPGRADER,
      "0x" + (10n ** 20n).toString(16),
    ]);
    await hre.network.provider.send("hardhat_impersonateAccount", [UPGRADER]);
  });

  after(async function () {
    if (!enabled) return;
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [UPGRADER]);
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: originalForkConfig ? [{ forking: originalForkConfig }] : [],
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. Confirm the fork really is Kairos, in the state we think it is.
  // ───────────────────────────────────────────────────────────────────────

  it("is forked onto the real Kairos proxy, with the retired slot genuinely dirty", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const impl = await hre.upgrades.erc1967.getImplementationAddress(IDRP_PROXY);
    expect(impl, "not the expected deployed implementation").to.equal(DEPLOYED_IMPL);

    // The whole reason this suite exists.
    expect(
      await hre.ethers.provider.getStorage(IDRP_PROXY, 9),
      "slot 9 is not dirty — the fork is stale or the chain changed"
    ).to.equal(LIVE_SLOT_9);
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 10)).to.equal(hre.ethers.ZeroHash);
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 11)).to.equal(hre.ethers.ZeroHash);

    pre = {
      admin: await idrp.admin(),
      upgrader: await idrp.upgrader(),
      controller: await idrp.controller(),
      depository: await idrp.depositoryWallet(),
      totalSupply: await idrp.totalSupply(),
      depositoryBalance: await idrp.balanceOf(await idrp.depositoryWallet()),
      delay: await idrp.UPGRADE_DELAY(),
      paused: await idrp.paused(),
    };

    expect(pre.upgrader).to.equal(UPGRADER);
    expect(pre.controller).to.equal(CTRL_PROXY);
    expect(pre.paused).to.equal(false);
    expect(pre.totalSupply).to.be.greaterThan(0n);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Run the real upgrade.
  // ───────────────────────────────────────────────────────────────────────

  it("schedules and executes the upgrade with the real upgrader", async function () {
    const upgrader = await hre.ethers.getImpersonatedSigner(UPGRADER);
    const idrp = (await hre.ethers.getContractAt("IDRP", IDRP_PROXY)).connect(upgrader) as any;

    const Factory = await hre.ethers.getContractFactory("IDRP", upgrader);
    const newImpl = await Factory.deploy();
    await newImpl.waitForDeployment();
    const newImplAddress = await newImpl.getAddress();

    await (await idrp.scheduleUpgrade(newImplAddress)).wait();
    expect(await idrp.scheduledImplementation()).to.equal(newImplAddress);

    // Wait out the delay of the CURRENTLY deployed implementation, not the new
    // one — the old code is what gates execution.
    await hre.network.provider.send("evm_increaseTime", [Number(pre.delay) + 1]);
    await hre.network.provider.send("evm_mine");

    await (await idrp.upgradeToAndCall(newImplAddress, "0x")).wait();

    expect(
      await hre.upgrades.erc1967.getImplementationAddress(IDRP_PROXY)
    ).to.equal(newImplAddress);
    expect(await idrp.scheduledImplementation()).to.equal(hre.ethers.ZeroAddress);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Nothing was lost.
  // ───────────────────────────────────────────────────────────────────────

  it("preserves every authority slot, balance and supply", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    expect(await idrp.admin()).to.equal(pre.admin);
    expect(await idrp.upgrader()).to.equal(pre.upgrader);
    expect(await idrp.controller()).to.equal(pre.controller);
    expect(await idrp.depositoryWallet()).to.equal(pre.depository);
    expect(await idrp.totalSupply()).to.equal(pre.totalSupply);
    expect(await idrp.balanceOf(pre.depository)).to.equal(pre.depositoryBalance);
    expect(await idrp.paused()).to.equal(false);
  });

  it("leaves the retired slots reserved and untouched", async function () {
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 9)).to.equal(LIVE_SLOT_9);
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 10)).to.equal(hre.ethers.ZeroHash);
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 11)).to.equal(hre.ethers.ZeroHash);
    // And the retired destination still holds whatever it held — the upgrade
    // does not sweep, move or reclaim it.
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    expect(await idrp.balanceOf(RETIRED_DESTINATION)).to.equal(0n);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. THE deadlock check: the freeze gate against a dirty slot 9.
  // ───────────────────────────────────────────────────────────────────────

  it("still enforces the freeze gate — the packed-slot hazard did not land", async function () {
    // If the retired address had been deleted rather than reserved,
    // `_inConfiscation` would sit at byte 0 of slot 9, read 0xcb as true, and
    // this transfer would succeed on the live chain.
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const [, , alice, bob] = await hre.ethers.getSigners();

    const depository = await hre.ethers.getImpersonatedSigner(pre.depository);
    await hre.network.provider.send("hardhat_setBalance", [
      pre.depository,
      "0x" + (10n ** 20n).toString(16),
    ]);
    await (await idrp.connect(depository).transfer(alice.address, 1_000_000n)).wait();

    const controller = await hre.ethers.getImpersonatedSigner(CTRL_PROXY);
    await hre.network.provider.send("hardhat_setBalance", [
      CTRL_PROXY,
      "0x" + (10n ** 20n).toString(16),
    ]);
    await (await idrp.connect(controller).freeze(alice.address)).wait();

    await expect(
      idrp.connect(alice).transfer(bob.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("seizes to the depository, then re-seals the gate", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const [, , alice, bob] = await hre.ethers.getSigners();
    const controller = await hre.ethers.getImpersonatedSigner(CTRL_PROXY);

    const aliceBalance = await idrp.balanceOf(alice.address);
    expect(aliceBalance).to.be.greaterThan(0n);
    const depositoryBefore = await idrp.balanceOf(pre.depository);
    const supplyBefore = await idrp.totalSupply();

    await expect(idrp.connect(controller).confiscate(alice.address, aliceBalance))
      .to.emit(idrp, "AssetsConfiscated")
      .withArgs(alice.address, pre.depository, aliceBalance);

    expect(await idrp.balanceOf(alice.address)).to.equal(0n);
    expect(await idrp.balanceOf(pre.depository)).to.equal(depositoryBefore + aliceBalance);
    expect(await idrp.totalSupply(), "a seizure must be a transfer, never a burn").to.equal(supplyBefore);

    // Target stays frozen, and the bypass flag is back off.
    expect(await idrp.frozen(alice.address)).to.equal(true);
    await expect(
      idrp.connect(bob).transfer(alice.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 9)).to.equal(LIVE_SLOT_9);
  });

  it("refuses to seize the depository itself instead of self-transferring", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const controller = await hre.ethers.getImpersonatedSigner(CTRL_PROXY);
    await (await idrp.connect(controller).freeze(pre.depository)).wait();
    await expect(
      idrp.connect(controller).confiscate(pre.depository, 1n)
    ).to.be.revertedWith("Cannot confiscate from the depository");
    await (await idrp.connect(controller).unfreeze(pre.depository)).wait();
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. Ordinary operation, and the ability to upgrade again.
  // ───────────────────────────────────────────────────────────────────────

  it("still mints, transfers, pauses and unpauses", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const [, , , , carol] = await hre.ethers.getSigners();
    const controller = await hre.ethers.getImpersonatedSigner(CTRL_PROXY);
    const depository = await hre.ethers.getImpersonatedSigner(pre.depository);

    const supplyBefore = await idrp.totalSupply();
    await (await idrp.connect(controller).mint(1_000_000n)).wait();
    expect(await idrp.totalSupply()).to.equal(supplyBefore + 1_000_000n);

    await (await idrp.connect(depository).transfer(carol.address, 500_000n)).wait();
    expect(await idrp.balanceOf(carol.address)).to.equal(500_000n);

    await (await idrp.connect(controller).pause()).wait();
    await expect(
      idrp.connect(carol).transfer(pre.depository, 1n)
    ).to.be.revertedWithCustomError(idrp, "EnforcedPause");
    await (await idrp.connect(controller).unpause()).wait();
    await (await idrp.connect(carol).transfer(pre.depository, 1n)).wait();
  });

  it("rejects the retired selectors instead of dispatching into live code", async function () {
    const [signer] = await hre.ethers.getSigners();
    for (const sig of [
      "scheduleConfiscationWallet(address)",
      "applyConfiscationWallet()",
      "cancelConfiscationWallet()",
      "confiscationWallet()",
      "pendingConfiscationWallet()",
      "confiscationWalletScheduledAt()",
    ]) {
      const data = hre.ethers.id(sig).slice(0, 10) + "0".repeat(64);
      await expect(
        signer.call({ to: IDRP_PROXY, data }),
        `${sig} still dispatches`
      ).to.be.reverted;
    }
  });

  it("can still be upgraded again — no upgrade deadlock", async function () {
    // The real "bricked" scenario: an upgrade that lands but leaves the proxy
    // unable to take the next one. Prove a second hop schedules and executes.
    const upgrader = await hre.ethers.getImpersonatedSigner(UPGRADER);
    const idrp = (await hre.ethers.getContractAt("IDRP", IDRP_PROXY)).connect(upgrader) as any;

    const Factory = await hre.ethers.getContractFactory("IDRP", upgrader);
    const nextImpl = await Factory.deploy();
    await nextImpl.waitForDeployment();
    const nextImplAddress = await nextImpl.getAddress();

    await (await idrp.scheduleUpgrade(nextImplAddress)).wait();
    await hre.network.provider.send("evm_increaseTime", [Number(await idrp.UPGRADE_DELAY()) + 1]);
    await hre.network.provider.send("evm_mine");
    await (await idrp.upgradeToAndCall(nextImplAddress, "0x")).wait();

    expect(
      await hre.upgrades.erc1967.getImplementationAddress(IDRP_PROXY)
    ).to.equal(nextImplAddress);
    // Still enforcing after a second hop, with slot 9 still dirty.
    expect(await hre.ethers.provider.getStorage(IDRP_PROXY, 9)).to.equal(LIVE_SLOT_9);
  });

  it("reports the UPGRADE_DELAY the new implementation brings", async function () {
    // Not a failure, a decision to make consciously: the deployed Kairos impl
    // was compiled with a 5-minute override, and the canonical source is 48h.
    // Shipping the canonical build slows every future Kairos upgrade to 48h.
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const after = await idrp.UPGRADE_DELAY();
    console.log(`\n  UPGRADE_DELAY before: ${pre.delay}s   after: ${after}s`);
    if (after !== pre.delay) {
      console.log(
        `  NOTE: Kairos's upgrade timelock changes ${pre.delay}s -> ${after}s with this build.`
      );
    }
    expect(after).to.be.greaterThan(0n);
  });
});

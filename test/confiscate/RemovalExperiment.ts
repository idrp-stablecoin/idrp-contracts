import hre from "hardhat";
import { expect } from "chai";

/**
 * EXPERIMENT — what actually happens if the retired confiscation slots are
 * DELETED rather than reserved, on the one chain that populated them?
 *
 * Run against real Kairos state, because the answer turned out not to be what
 * reasoning predicted.
 *
 * The scrub half of this experiment is gone: initializeV4 was removed once every
 * live proxy was confirmed to read zero at slots 9-11. What remains is the part
 * that still describes today's contract — that deleting the retired variables
 * repacks the freeze flag safely.
 *
 * THE PREDICTION THAT WAS WRONG: that `_inConfiscation` would slide to byte 0 of
 * slot 9, read the retired address's low byte `0xcb` as `true`, and disable the
 * freeze gate. It does not. Solidity packs in declaration order, so with the
 * retired address gone the bool fits in `controller`'s slot (8) at byte 20 —
 * and byte 20 of a 20-byte address is zero. The gate keeps working.
 *
 * THE HAZARD THAT IS REAL: slot 9 keeps the retired address, unclaimed and
 * unreferenced. The next storage variable anyone appends lands there and reads
 * `0xF1c508CE…C3CB` as its initial value — silently, on one chain only.
 *
 *   KAIROS_FORK_RPC_URL=https://public-en-kairos.node.kaia.io \
 *     npx hardhat test test/confiscate/RemovalExperiment.ts
 */

const IDRP_PROXY = "0x999f947F3c7C0cF64AE53571a7fda51ce7f66164";
const UPGRADER = "0x0FC4CBd7f60E0BE5FeaCFAB6B8818F88763f9640";
const RETIRED_DESTINATION = "0xF1c508CE6B951475F204ae2d68527c6cF995C3CB";
const LIVE_SLOT_9 =
  "0x000000000000000000000000f1c508ce6b951475f204ae2d68527c6cf995c3cb";

describe("EXPERIMENT: deleting the retired slots, against real Kairos state", function () {
  this.timeout(300_000);

  let originalForkConfig: unknown;
  let enabled = false;
  let controllerAddress: string;

  before(async function () {
    const rpcUrl = process.env.KAIROS_FORK_RPC_URL;
    if (!rpcUrl) {
      console.log("\n  [skipping] set KAIROS_FORK_RPC_URL to run the experiment.");
      this.skip();
    }
    enabled = true;
    originalForkConfig = (hre.network.config as { forking?: unknown }).forking;

    // Kaia makes ~1 block/second and public nodes keep ~100 blocks of state, so
    // pin a block just behind head and keep the run short.
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

  /** Deploys `name`, schedules it through the timelock, and executes. */
  async function upgradeTo(name: string) {
    const upgrader = await hre.ethers.getImpersonatedSigner(UPGRADER);
    const idrp = (await hre.ethers.getContractAt("IDRP", IDRP_PROXY)).connect(upgrader) as any;
    const Factory = await hre.ethers.getContractFactory(name, upgrader);
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    const addr = await impl.getAddress();
    await (await idrp.scheduleUpgrade(addr)).wait();
    await hre.network.provider.send("evm_increaseTime", [
      Number(await idrp.UPGRADE_DELAY()) + 1,
    ]);
    await hre.network.provider.send("evm_mine");
    await (await idrp.upgradeToAndCall(addr, "0x")).wait();
    return addr;
  }

  it("starts from the real thing: slot 8 = controller, slot 9 = the retired address", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    controllerAddress = await idrp.controller();
    const slot8 = await hre.ethers.provider.getStorage(IDRP_PROXY, 8);
    const slot9 = await hre.ethers.provider.getStorage(IDRP_PROXY, 9);

    expect(slot9, "fork is stale — slot 9 is not the retired address").to.equal(LIVE_SLOT_9);
    // The byte the relocated flag will occupy.
    const b8 = slot8.slice(2).match(/../g)!;
    console.log(`    slot 8 byte 20 (where the flag lands) = 0x${b8[31 - 20]}`);
    console.log(`    slot 9 byte  0 (where it was feared to land) = 0x${slot9.slice(-2)}`);
    expect(b8[31 - 20], "controller's byte 20 must be clear").to.equal("00");
  });

  it("does NOT break the freeze gate — the flag repacks into controller's slot", async function () {
    await upgradeTo("IDRP");
    const idrp = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    const [, , alice, bob] = await hre.ethers.getSigners();

    const depository = await idrp.depositoryWallet();
    await hre.network.provider.send("hardhat_setBalance", [
      depository,
      "0x" + (10n ** 20n).toString(16),
    ]);
    const dep = await hre.ethers.getImpersonatedSigner(depository);
    await (await idrp.connect(dep).transfer(alice.address, 1_000_000n)).wait();

    await hre.network.provider.send("hardhat_setBalance", [
      controllerAddress,
      "0x" + (10n ** 20n).toString(16),
    ]);
    const ctrl = await hre.ethers.getImpersonatedSigner(controllerAddress);
    await (await idrp.connect(ctrl).freeze(alice.address)).wait();

    // The prediction under test. If the flag had landed on 0xcb this passes gas
    // and moves the tokens instead of reverting.
    await expect(
      idrp.connect(alice).transfer(bob.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");

    // And a seizure still works end to end.
    const before = await idrp.balanceOf(depository);
    await (await idrp.connect(ctrl).confiscate(alice.address, 1_000_000n)).wait();
    expect(await idrp.balanceOf(depository)).to.equal(before + 1_000_000n);
    expect(await idrp.frozen(alice.address)).to.equal(true);
  });

});

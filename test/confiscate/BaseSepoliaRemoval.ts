import hre from "hardhat";
import { expect } from "chai";

/**
 * Is removing the retired slots safe on a proxy whose slot 9 is CLEAN?
 *
 * Base Sepolia ran the placeholder variant but never applied a confiscation
 * wallet, so slots 9-11 are zero there. Kairos applied one, so its slot 9 holds
 * `0x…f1c508ce…c3cb`. That difference is the whole question: it decides whether
 * the removal needs `initializeV4` to scrub an orphan, or nothing at all.
 *
 * Run against the live OLD proxy on a fork, upgrading it the way a real upgrade
 * would — plain factory + upgradeToAndCall, which is how this repo's deploy
 * scripts work and which does not consult OZ's validator.
 *
 *   BASE_SEPOLIA_FORK=1 npx hardhat test test/confiscate/BaseSepoliaRemoval.ts
 */

const TOKEN = "0x817d0C3D4e63231d88B2d73217B7fB75b87e0606";   // OLD, placeholder variant
const CONTROLLER = "0x466d7B865e394f640aa436a399A464f7dC65C410";
const UPGRADER = "0x1EE445Fbc60EE07fDdE916F49f94D6953D4d8D6C";

describe("Base Sepolia OLD token — removing the retired slots from a CLEAN proxy", function () {
  this.timeout(300_000);

  let enabled = false;
  let originalForkConfig: unknown;
  let depository: string;

  before(async function () {
    if (!process.env.BASE_SEPOLIA_FORK) {
      console.log("\n  [skipping] set BASE_SEPOLIA_FORK=1 to run.");
      this.skip();
    }
    enabled = true;
    const rpcUrl = (hre.config.networks as any).baseSepolia.url as string;
    originalForkConfig = (hre.network.config as { forking?: unknown }).forking;
    const probe = new hre.ethers.JsonRpcProvider(rpcUrl);
    const blockNumber = (await probe.getBlockNumber()) - 5;
    probe.destroy();
    console.log(`  forking Base Sepolia at block ${blockNumber}`);
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: rpcUrl, blockNumber } }],
    });
    await hre.network.provider.send("hardhat_setBalance", [UPGRADER, "0x" + (10n ** 20n).toString(16)]);
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

  async function upgradeTo(name: string, withInitV4: boolean) {
    const upgrader = await hre.ethers.getImpersonatedSigner(UPGRADER);
    const idrp = (await hre.ethers.getContractAt("IDRP", TOKEN)).connect(upgrader) as any;
    const Factory = await hre.ethers.getContractFactory(name, upgrader);
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    const addr = await impl.getAddress();
    await (await idrp.scheduleUpgrade(addr)).wait();
    await hre.network.provider.send("evm_increaseTime", [Number(await idrp.UPGRADE_DELAY()) + 1]);
    await hre.network.provider.send("evm_mine");
    const data = withInitV4 ? Factory.interface.encodeFunctionData("initializeV4", []) : "0x";
    await (await idrp.upgradeToAndCall(addr, data)).wait();
    return addr;
  }

  it("starts from the real placeholder proxy with slots 9-11 already clean", async function () {
    const idrp = await hre.ethers.getContractAt("IDRP", TOKEN);
    depository = await idrp.depositoryWallet();
    for (const slot of [9, 10, 11]) {
      expect(
        await hre.ethers.provider.getStorage(TOKEN, slot),
        `slot ${slot} is not clean — this chain is not the case under test`
      ).to.equal(hre.ethers.ZeroHash);
    }
    // The byte the relocated flag will land on.
    const slot8 = await hre.ethers.provider.getStorage(TOKEN, 8);
    expect(slot8.slice(2).match(/../g)![31 - 20]).to.equal("00");
    expect(await idrp.totalSupply()).to.be.greaterThan(0n);
  });

  it("removes the slots with NO initializeV4 and keeps the freeze gate enforced", async function () {
    // Deliberately passing "0x" — no scrub. On this chain there is nothing to
    // scrub, which is exactly the claim being tested.
    const supplyBefore = await (await hre.ethers.getContractAt("IDRP", TOKEN)).totalSupply();
    await upgradeTo("IDRP", false);

    const idrp = await hre.ethers.getContractAt("IDRP", TOKEN);
    const [, , alice, bob] = await hre.ethers.getSigners();
    expect(await idrp.totalSupply()).to.equal(supplyBefore);
    expect(await idrp.depositoryWallet()).to.equal(depository);
    expect(await idrp.controller()).to.equal(CONTROLLER);

    await hre.network.provider.send("hardhat_setBalance", [depository, "0x" + (10n ** 20n).toString(16)]);
    await hre.network.provider.send("hardhat_setBalance", [CONTROLLER, "0x" + (10n ** 20n).toString(16)]);
    const dep = await hre.ethers.getImpersonatedSigner(depository);
    const ctrl = await hre.ethers.getImpersonatedSigner(CONTROLLER);

    await (await idrp.connect(dep).transfer(alice.address, 1_000_000n)).wait();
    await (await idrp.connect(ctrl).freeze(alice.address)).wait();
    await expect(
      idrp.connect(alice).transfer(bob.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");

    // A seizure still works end to end, and re-seals.
    const depBefore = await idrp.balanceOf(depository);
    await (await idrp.connect(ctrl).confiscate(alice.address, 1_000_000n)).wait();
    expect(await idrp.balanceOf(depository)).to.equal(depBefore + 1_000_000n);
    expect(await idrp.totalSupply()).to.equal(supplyBefore);
    await expect(
      idrp.connect(bob).transfer(alice.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("leaves NO orphan — a newly appended variable reads zero, unlike Kairos", async function () {
    // THE difference between the two chains. On Kairos this same probe reads back
    // 0xF1c508CE…C3CB; here it must read zero, because nothing was ever written
    // to slot 9. That is why Base Sepolia needs no scrub and Kairos does.
    await upgradeTo("IDRPNextVarProbeMock", false);
    const probe = await hre.ethers.getContractAt("IDRPNextVarProbeMock", TOKEN);
    const inherited = await probe.nextFeatureSlot();
    console.log(`    newly appended address variable reads: ${inherited}`);
    expect(inherited).to.equal(hre.ethers.ZeroAddress);
  });
});

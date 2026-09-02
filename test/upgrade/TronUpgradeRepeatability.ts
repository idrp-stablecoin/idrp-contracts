import { expect } from "chai";
import hre from "hardhat";

/**
 * Upgrade repeatability for the Tron implementations.
 *
 * These run on the local EVM, so they prove the *logic*: storage layout, the upgrade
 * authorisation path, and whether a proxy can be upgraded more than once. They do NOT
 * prove TVM-specific behaviour — immutable-opcode support is a Tron question, and is
 * covered separately by scripts/nile-upgrade-rig.ts.
 *
 * Everything here is deterministic and free, so it belongs in CI: the second test is a
 * regression guard for the failure that froze the Nile Controller on 2026-09-02.
 */
describe("Tron upgrade repeatability", function () {
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

  // Slots the live Tron proxies actually use. Verified on mainnet.
  const LIVE = { idrpToken: 251, upgradeScheduledAt: 256, scheduledImplementation: 257, upgrader: 258 };

  const slotAddr = async (proxy: string, slot: number | string) => {
    const raw = await hre.ethers.provider.getStorage(proxy, slot);
    return hre.ethers.getAddress("0x" + raw.slice(-40));
  };

  async function deployProxied(implName: string) {
    const [deployer] = await hre.ethers.getSigners();
    const Impl = await hre.ethers.getContractFactory(implName);
    const implA = await Impl.deploy();
    await implA.waitForDeployment();

    const token = deployer.address; // only stored, never called
    const initData = Impl.interface.encodeFunctionData("initialize", [token, deployer.address]);
    const Proxy = await hre.ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.deploy(await implA.getAddress(), initData);
    await proxy.waitForDeployment();

    return {
      deployer,
      Impl,
      proxyAddr: await proxy.getAddress(),
      implAAddr: await implA.getAddress(),
      c: Impl.attach(await proxy.getAddress()) as any,
    };
  }

  async function scheduleAndUpgrade(c: any, target: string) {
    await c.scheduleUpgrade(target);
    const delay = await c.UPGRADE_DELAY();
    await hre.network.provider.send("evm_increaseTime", [Number(delay) + 1]);
    await hre.network.provider.send("evm_mine");
    // Data-less upgrades MUST use upgradeTo. OZ 4's upgradeToAndCall passes
    // forceCall = true, so it delegatecalls even with empty calldata, which lands in
    // the new implementation's fallback and reverts
    // "Address: low-level delegate call failed". upgradeTo passes forceCall = false.
    await c.upgradeTo(target);
  }

  it("keeps the storage layout the live Tron proxies expect", async function () {
    const { proxyAddr, deployer } = await deployProxied("IDRPController");

    expect(await slotAddr(proxyAddr, LIVE.idrpToken)).to.equal(deployer.address);
    expect(await slotAddr(proxyAddr, LIVE.upgrader)).to.equal(deployer.address);

    // Nothing must land where the legacy parent storage lives.
    const gapProbe = await hre.ethers.provider.getStorage(proxyAddr, 7);
    expect(BigInt(gapProbe)).to.equal(0n, "slot 7 belongs to the legacy gap and must stay empty");
  });

  it("can be upgraded repeatedly — three consecutive upgrades", async function () {
    const { Impl, proxyAddr, implAAddr, c } = await deployProxied("IDRPController");

    // Both TronUUPS slot generations must be empty, i.e. the same state as the live
    // Tron mainnet proxies. A fresh proxy that self-initialised one would not be
    // representative — that difference is precisely what froze the Nile Controller.
    for (const name of ["idrp.tron.uups.__self", "idrp.tron.uups.__proxy"]) {
      const v = await hre.ethers.provider.getStorage(
        proxyAddr, hre.ethers.keccak256(hre.ethers.toUtf8Bytes(name)));
      expect(BigInt(v)).to.equal(0n, `${name} must be empty to mirror mainnet`);
    }

    const implB = await (await Impl.deploy()).waitForDeployment();
    const implBAddr = await implB.getAddress();

    for (const [n, target] of [[1, implBAddr], [2, implAAddr], [3, implBAddr]] as [number, string][]) {
      await scheduleAndUpgrade(c, target);
      expect(await slotAddr(proxyAddr, IMPL_SLOT)).to.equal(target, `upgrade #${n} did not take effect`);
    }

    // Still reachable and still correctly aligned after three swaps.
    expect(await c.upgrader()).to.equal(await slotAddr(proxyAddr, LIVE.upgrader));
  });

  it("REGRESSION: a storage-slot UUPS freezes a proxy that never ran its initializer", async function () {
    // This is the bug that froze the Nile Controller. TronUUPSUpgradeable keeps the proxy
    // address in storage and gates every upgrade entry point on it, but that slot is
    // written only from an initializer. Upgrading INTO such an implementation succeeds,
    // because the OLD implementation performs the upgrade and never checks the slot —
    // and every upgrade after it reverts.
    const { Impl, proxyAddr, c } = await deployProxied("IDRPController");

    const Legacy = await hre.ethers.getContractFactory("StorageSlotUUPSMock");
    const legacy = await (await Legacy.deploy()).waitForDeployment();
    const legacyAddr = await legacy.getAddress();

    await scheduleAndUpgrade(c, legacyAddr); // succeeds — the old impl does the work
    expect(await slotAddr(proxyAddr, IMPL_SLOT)).to.equal(legacyAddr);

    // ...and now the proxy is stuck.
    const next = await (await Impl.deploy()).waitForDeployment();
    const stuck = Legacy.attach(proxyAddr) as any;
    await expect(stuck.upgradeTo(await next.getAddress()))
      .to.be.revertedWithCustomError(legacy, "TronUUPSUnauthorizedCallContext");
  });
});

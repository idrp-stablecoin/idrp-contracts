import fs from "fs";
import path from "path";
import hre from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Battle test for the TRON lineage (OpenZeppelin 4.9.6, sequential storage).
 *
 * Tron cannot be forked — TronGrid exposes no archive node and the TVM is not
 * an EVM — so "measure, do not predict" here means reconstructing the real
 * layouts from the real legacy sources and driving the actual upgrade paths,
 * rather than reading a validator's opinion.
 *
 * What this is looking for, in order of how badly it would hurt:
 *
 *  1. A variable landing on a different slot after an upgrade. On this lineage
 *     that is catastrophic and silent: v3 drops AccessControl + ERC165, whose
 *     100 slots sit BEFORE EIP712. If `LegacyAccessControlSlots` ever stops
 *     reserving exactly 100, DOMAIN_SEPARATOR moves and permit() breaks with no
 *     error anywhere.
 *  2. A future feature appending onto occupied storage.
 *  3. An upgrade path that reverts, or one that succeeds but corrupts state.
 *
 * The exact slot numbers below are asserted deliberately. They are not
 * documentation — they are the thing under test, and a reordering that changes
 * any of them must fail here rather than on a chain.
 */

const UPGRADE_DELAY = 48 * 3600;

/** The layout the live Tron proxies assume. Changing any number here is a migration. */
const TOKEN_SLOTS: Record<string, [number, number]> = {
  __legacyAccessControlGap: [201, 0],   // 100 slots, 201-300 — must stay exactly 100
  _hashedName: [301, 0],                // EIP712 — sits AFTER the reserved gap
  _hashedVersion: [302, 0],
  _nonces: [353, 0],                    // permit nonces
  frozen: [504, 0],
  depositoryWallet: [505, 0],
  maxSupply: [506, 0],
  upgrader: [507, 0],
  upgradeScheduledAt: [508, 0],
  scheduledImplementation: [509, 0],
  sanctionsList: [510, 0],
  admin: [511, 0],
  controller: [512, 0],
  _inConfiscation: [512, 20],           // packed with controller, byte 20
};

const CONTROLLER_SLOTS: Record<string, [number, number]> = {
  _roles: [101, 0],                     // controller KEEPS AccessControl, unlike the token
  _pendingDefaultAdmin: [151, 0],
  _currentDefaultAdmin: [152, 0],
  idrpToken: [251, 0],
  nonce: [252, 0],
  quorumRules: [253, 0],
  usedSignatures: [254, 0],
  DOMAIN_SEPARATOR: [255, 0],
  upgradeScheduledAt: [256, 0],
  scheduledImplementation: [257, 0],
  upgrader: [258, 0],
  pendingQuorumRules: [259, 0],
};

function layoutOf(file: string, name: string) {
  const dbgPath = path.join(hre.config.paths.artifacts, `contracts/${file}/${name}.dbg.json`);
  const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(path.dirname(dbgPath), dbg.buildInfo), "utf8"));
  return bi.output.contracts[`contracts/${file}`][name].storageLayout;
}

const ALLOW = ["missing-initializer-call", "state-variable-immutable", "state-variable-assignment"];

describe("TRON battle test — layout, upgrade paths, and future headroom", function () {
  this.timeout(120_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 1. The layout itself, pinned to exact numbers.
  // ─────────────────────────────────────────────────────────────────────────

  it("token: every variable is on the slot the live proxies assume", function () {
    const l = layoutOf("IDRP.sol", "IDRP");
    for (const [label, [slot, offset]] of Object.entries(TOKEN_SLOTS)) {
      const v = l.storage.find((x: any) => x.label === label);
      expect(v, `token variable ${label} is GONE from storage`).to.not.equal(undefined);
      expect(Number(v.slot), `token ${label} moved slot`).to.equal(slot);
      expect(Number(v.offset), `token ${label} moved offset`).to.equal(offset);
    }
  });

  it("token: the legacy AccessControl reservation is exactly 100 slots", function () {
    // The single most dangerous number on this lineage. AccessControlUpgradeable
    // + ERC165Upgradeable occupied 100 slots; v3 dropped both. Reserve 99 or 101
    // and EIP712 shifts, taking DOMAIN_SEPARATOR and permit() with it — silently.
    const l = layoutOf("IDRP.sol", "IDRP");
    const gap = l.storage.find((x: any) => x.label === "__legacyAccessControlGap");
    expect(Number(l.types[gap.type].numberOfBytes)).to.equal(100 * 32);
    // And the very next declared variable must start at 301.
    const next = l.storage.find((x: any) => Number(x.slot) === 301);
    expect(next, "nothing occupies slot 301 — the gap size or position changed").to.not.equal(undefined);
  });

  it("controller: every variable is on the slot the live proxies assume", function () {
    const l = layoutOf("IDRPController.sol", "IDRPController");
    for (const [label, [slot, offset]] of Object.entries(CONTROLLER_SLOTS)) {
      const v = l.storage.find((x: any) => x.label === label);
      expect(v, `controller variable ${label} is GONE`).to.not.equal(undefined);
      expect(Number(v.slot), `controller ${label} moved slot`).to.equal(slot);
      expect(Number(v.offset), `controller ${label} moved offset`).to.equal(offset);
    }
  });

  it("token: confiscate added NO new slot — the flag packs into controller's", function () {
    const l = layoutOf("IDRP.sol", "IDRP");
    const max = Math.max(...l.storage.map((v: any) => Number(v.slot)));
    expect(max, "confiscate consumed a slot of its own; it should pack at 512:20").to.equal(512);
    for (const v of l.storage) {
      expect(v.label, `unexpected placeholder on the Tron lineage: ${v.label}`).to.not.match(/^__deprecated_/);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Upgrade paths, driven for real.
  // ─────────────────────────────────────────────────────────────────────────

  /** Deploys a v2 token proxy with real state on it. */
  async function v2TokenWithState() {
    const [deployer, holder, other] = await hre.ethers.getSigners();
    const V2 = await hre.ethers.getContractFactory("IDRPv2");
    const proxy: any = await hre.upgrades.deployProxy(V2, [deployer.address], {
      kind: "uups", unsafeAllow: ALLOW,
    });
    await proxy.waitForDeployment();
    await (await proxy.setDepositoryWallet(deployer.address)).wait();
    await (await proxy.mint(hre.ethers.parseUnits("1000000", 6))).wait();
    await (await proxy.transfer(holder.address, hre.ethers.parseUnits("1234", 6))).wait();
    return { proxy, addr: await proxy.getAddress(), deployer, holder, other };
  }

  async function snapshot(c: any) {
    return {
      supply: await c.totalSupply(),
      name: await c.name(),
      symbol: await c.symbol(),
      decimals: await c.decimals(),
      domain: await c.DOMAIN_SEPARATOR(),
      depository: await c.depositoryWallet(),
    };
  }

  it("token v2 -> v3 preserves EVERY value, DOMAIN_SEPARATOR included", async function () {
    const { proxy, addr, deployer, holder } = await v2TokenWithState();
    const before = { ...(await snapshot(proxy)), holder: await proxy.balanceOf(holder.address), nonce: await proxy.nonces(holder.address) };

    const V3 = await hre.ethers.getContractFactory("IDRP");
    const impl = await V3.deploy(); await impl.waitForDeployment();
    await (await proxy.scheduleUpgrade(await impl.getAddress())).wait();
    await time.increase(UPGRADE_DELAY + 1);
    await (await proxy.upgradeToAndCall(await impl.getAddress(),
      V3.interface.encodeFunctionData("initializeV3", [deployer.address, deployer.address, deployer.address]))).wait();

    const v3 = await hre.ethers.getContractAt("IDRP", addr);
    const after = { ...(await snapshot(v3)), holder: await v3.balanceOf(holder.address), nonce: await v3.nonces(holder.address) };
    expect(after).to.deep.equal(before);
    expect(await v3.admin()).to.equal(deployer.address);
  });

  it("token survives a SECOND hop — one upgrade working is not proof", async function () {
    // A layout error can hide behind the first upgrade and only bite on the next.
    const { proxy, addr, deployer, holder } = await v2TokenWithState();
    const V3 = await hre.ethers.getContractFactory("IDRP");

    const a = await V3.deploy(); await a.waitForDeployment();
    await (await proxy.scheduleUpgrade(await a.getAddress())).wait();
    await time.increase(UPGRADE_DELAY + 1);
    await (await proxy.upgradeToAndCall(await a.getAddress(),
      V3.interface.encodeFunctionData("initializeV3", [deployer.address, deployer.address, deployer.address]))).wait();

    const v3: any = await hre.ethers.getContractAt("IDRP", addr);
    const mid = { ...(await snapshot(v3)), holder: await v3.balanceOf(holder.address) };

    // Second hop, same source, no initializer data.
    const b = await V3.deploy(); await b.waitForDeployment();
    await (await v3.connect(deployer).scheduleUpgrade(await b.getAddress())).wait();
    await time.increase(UPGRADE_DELAY + 1);
    // NOTE: upgradeTo, not upgradeToAndCall — see the OZ4 semantics test below.
    await (await v3.connect(deployer).upgradeTo(await b.getAddress())).wait();

    const after = { ...(await snapshot(v3)), holder: await v3.balanceOf(holder.address) };
    expect(after).to.deep.equal(mid);
    expect(await v3.admin()).to.equal(deployer.address);
  });

  it("⚠️ OZ4: upgradeToAndCall(impl, \"0x\") REVERTS — use upgradeTo for a no-data upgrade", async function () {
    // Not a quirk of the test: OZ 4.9.6's upgradeToAndCall passes forceCall=true,
    // so it delegatecalls the implementation with empty calldata and hits a
    // fallback that does not exist. OZ 5 skips the call when data is empty, which
    // is why the EVM scripts get away with `upgradeToAndCall(impl, "0x")`.
    // Any Tron runbook copying that line would fail at execute time.
    const { proxy, deployer } = await v2TokenWithState();
    const V3 = await hre.ethers.getContractFactory("IDRP");
    const impl = await V3.deploy(); await impl.waitForDeployment();
    await (await proxy.scheduleUpgrade(await impl.getAddress())).wait();
    await time.increase(UPGRADE_DELAY + 1);

    await expect(
      proxy.connect(deployer).upgradeToAndCall(await impl.getAddress(), "0x")
    ).to.be.revertedWith("Address: low-level delegate call failed");

    // The correct call for the same intent.
    await expect(proxy.connect(deployer).upgradeTo(await impl.getAddress())).to.not.be.reverted;
  });

  it("token: confiscate works on a MIGRATED proxy, and the freeze gate holds", async function () {
    const { proxy, addr, deployer, holder, other } = await v2TokenWithState();
    const V3 = await hre.ethers.getContractFactory("IDRP");
    const impl = await V3.deploy(); await impl.waitForDeployment();
    await (await proxy.scheduleUpgrade(await impl.getAddress())).wait();
    await time.increase(UPGRADE_DELAY + 1);
    await (await proxy.upgradeToAndCall(await impl.getAddress(),
      V3.interface.encodeFunctionData("initializeV3", [deployer.address, deployer.address, deployer.address]))).wait();

    const v3: any = await hre.ethers.getContractAt("IDRP", addr);
    await (await v3.freeze(holder.address)).wait();
    await expect(v3.connect(holder).transfer(other.address, 1n)).to.be.revertedWithCustomError(v3, "FrozenAccount");

    const supply = await v3.totalSupply();
    const depBefore = await v3.balanceOf(deployer.address);
    const seized = await v3.balanceOf(holder.address);
    await (await v3.confiscate(holder.address, seized)).wait();
    expect(await v3.balanceOf(deployer.address)).to.equal(depBefore + seized);
    expect(await v3.totalSupply(), "a seizure must be a transfer, never a burn").to.equal(supply);
    expect(await v3.frozen(holder.address)).to.equal(true);
    // Gate re-sealed — the packed flag at 512:20 was cleared.
    await expect(v3.connect(other).transfer(holder.address, 1n)).to.be.revertedWithCustomError(v3, "FrozenAccount");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Headroom for the NEXT feature.
  // ─────────────────────────────────────────────────────────────────────────

  it("token: a future feature appends at slot 513, onto untouched storage", async function () {
    const l = layoutOf("contracts/mocks/IDRPTronNextFeature.sol".replace("contracts/", ""), "IDRPTronNextFeature");
    const v = l.storage.find((x: any) => x.label === "someFutureWallet");
    expect(v, "probe variable missing").to.not.equal(undefined);
    expect(Number(v.slot), "a future token variable must land on 513").to.equal(513);
  });

  it("controller: a future feature appends at slot 260, onto untouched storage", function () {
    const l = layoutOf("mocks/IDRPTronNextFeature.sol", "IDRPControllerTronNextFeature");
    const v = l.storage.find((x: any) => x.label === "someFutureSetting");
    expect(Number(v.slot), "a future controller variable must land on 260").to.equal(260);
  });
});

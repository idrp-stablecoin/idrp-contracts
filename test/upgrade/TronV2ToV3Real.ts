import hre from "hardhat";
import { expect } from "chai";

/**
 * Does the Tron v2 -> v3 upgrade actually WORK, as opposed to passing the
 * validator?
 *
 * OpenZeppelin rejects it: v3 drops `AccessControlUpgradeable` and
 * `ERC165Upgradeable`, so their named variables (`_roles`, two `__gap`s)
 * disappear from the layout. But `LegacyAccessControlSlots` reserves exactly the
 * 100 slots they occupied, so the space is preserved and everything after them
 * stays put. That is the same shape as the retired confiscation slots: the
 * validator objects to missing NAMES, which is not a statement about the chain.
 *
 * That distinction cost a lot of pointless work once already, so this measures it
 * instead of arguing. A v2 proxy is deployed with the REAL legacy source, filled
 * with state, upgraded to v3 the way a real upgrade would (direct
 * upgradeToAndCall, no plugin), and then every pre-existing value is read back.
 *
 * The value most at risk is DOMAIN_SEPARATOR: EIP712 sits AFTER the dropped
 * parents, so if the 100 slots were not reserved it would move and permit()
 * would break silently.
 */
describe("Tron lineage — v2 -> v3 upgrade, measured rather than validated", function () {
  it("preserves every v2 value across the upgrade, including DOMAIN_SEPARATOR", async function () {
    const [deployer, holder, other] = await hre.ethers.getSigners();

    // ── Deploy the REAL v2 source and give it state ──────────────────────────
    const V2 = await hre.ethers.getContractFactory("IDRPv2");
    const proxy = await hre.upgrades.deployProxy(V2, [deployer.address], {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call", "state-variable-immutable", "state-variable-assignment"],
    });
    await proxy.waitForDeployment();
    const addr = await proxy.getAddress();
    const v2 = proxy as any;

    await (await v2.setDepositoryWallet(deployer.address)).wait();
    const MINTER = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MINTER_ROLE"));
    try { await (await v2.grantRole(MINTER, deployer.address)).wait(); } catch {}
    await (await v2.mint(hre.ethers.parseUnits("1000000", 6))).wait();
    await (await v2.transfer(holder.address, hre.ethers.parseUnits("1234", 6))).wait();

    const before = {
      supply: await v2.totalSupply(),
      holder: await v2.balanceOf(holder.address),
      depository: await v2.depositoryWallet(),
      domain: await v2.DOMAIN_SEPARATOR(),
      nonce: await v2.nonces(holder.address),
      name: await v2.name(),
      symbol: await v2.symbol(),
      decimals: await v2.decimals(),
    };
    expect(before.holder).to.be.greaterThan(0n);

    // ── Upgrade to v3 the way a real upgrade does: no plugin, no validator ────
    const V3 = await hre.ethers.getContractFactory("IDRP");
    const impl = await V3.deploy();
    await impl.waitForDeployment();
    const implAddr = await impl.getAddress();

    // v2 enforces its own 48h scheduleUpgrade timelock — the same flow a real
    // Tron upgrade goes through.
    await (await v2.scheduleUpgrade(implAddr)).wait();
    await hre.network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
    await hre.network.provider.send("evm_mine");

    const initData = V3.interface.encodeFunctionData("initializeV3", [
      deployer.address, deployer.address, deployer.address,
    ]);
    await (await v2.upgradeToAndCall(implAddr, initData)).wait();

    // ── Read everything back ─────────────────────────────────────────────────
    const v3 = await hre.ethers.getContractAt("IDRP", addr);
    expect(await v3.totalSupply(), "totalSupply moved").to.equal(before.supply);
    expect(await v3.balanceOf(holder.address), "balance moved").to.equal(before.holder);
    expect(await v3.depositoryWallet(), "depositoryWallet moved").to.equal(before.depository);
    expect(await v3.name()).to.equal(before.name);
    expect(await v3.symbol()).to.equal(before.symbol);
    expect(await v3.decimals()).to.equal(before.decimals);
    expect(await v3.nonces(holder.address), "permit nonce moved").to.equal(before.nonce);

    // THE one that would break silently. EIP712 lives after the dropped parents.
    expect(
      await v3.DOMAIN_SEPARATOR(),
      "DOMAIN_SEPARATOR moved — the 100 reserved slots did not hold"
    ).to.equal(before.domain);

    // v3 authority is wired, and the token still works.
    expect(await v3.admin()).to.equal(deployer.address);
    expect(await v3.controller()).to.equal(deployer.address);
    expect(await v3.upgrader()).to.equal(deployer.address);
    await (await v3.connect(holder).transfer(other.address, 1n)).wait();
    expect(await v3.balanceOf(other.address)).to.equal(1n);

    // And confiscate — the feature this branch adds — works on the migrated proxy.
    await (await v3.freeze(holder.address)).wait();
    const depBefore = await v3.balanceOf(before.depository);
    const seized = await v3.balanceOf(holder.address);
    await (await v3.confiscate(holder.address, seized)).wait();
    expect(await v3.balanceOf(before.depository)).to.equal(depBefore + seized);
    expect(await v3.totalSupply()).to.equal(before.supply);
  });
});

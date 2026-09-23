import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * TOKEN v2 → v3 ON A PROXY THAT HAS HISTORY.
 *
 * The companion to the controller migration. Tron mainnet's token holds real
 * balances, a depository wallet, frozen accounts and permit nonces, so this
 * seeds all of that on a v2 proxy and then migrates it, asserting nothing is
 * lost — and that authority actually moves: v3 drops the role checks, so after
 * the migration only `controller` may mint, and MINTER_ROLE means nothing.
 */
describe("Token v2 → v3 on a proxy with state", function () {
  const ROLE = (n: string) => hre.ethers.keccak256(hre.ethers.toUtf8Bytes(n));
  const MINTER_ROLE = ROLE("MINTER_ROLE");
  const FREEZER_ROLE = ROLE("FREEZER_ROLE");
  const PAUSER_ROLE = ROLE("PAUSER_ROLE");

  const AMOUNT = hre.ethers.parseUnits("1000000", 6);

  async function seededV2Fixture() {
    const [admin, minter, depository, holder, frozen, controller] =
      await hre.ethers.getSigners();

    const idrp = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPv2"),
      [admin.address],
    );
    await idrp.waitForDeployment();

    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).grantRole(MINTER_ROLE, minter.address);
    await idrp.connect(admin).grantRole(FREEZER_ROLE, admin.address);
    await idrp.connect(admin).grantRole(PAUSER_ROLE, admin.address);

    // Real balances: mint to the depository, then move some out to a holder.
    await idrp.connect(minter).mint(AMOUNT);
    await idrp.connect(depository).transfer(holder.address, AMOUNT / 4n);

    // A frozen account, as a chain with sanctions history would have.
    await idrp.connect(admin).freeze(frozen.address);

    return { idrp, admin, minter, depository, holder, frozen, controller };
  }

  async function migrate(idrp: any, admin: any, controller: string) {
    const v3 = await hre.ethers.getContractFactory("IDRP");
    const impl = await v3.deploy();
    await impl.waitForDeployment();
    const implAddress = await impl.getAddress();

    await idrp.connect(admin).scheduleUpgrade(implAddress);
    await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine", []);

    const data = v3.interface.encodeFunctionData("initializeV3", [
      admin.address,
      controller,
      admin.address,
    ]);
    await idrp.connect(admin).upgradeToAndCall(implAddress, data);

    return hre.ethers.getContractAt("IDRP", await idrp.getAddress());
  }

  it("keeps balances, supply, the depository and frozen accounts", async function () {
    const { idrp, admin, depository, holder, frozen, controller } =
      await loadFixture(seededV2Fixture);

    const before = {
      supply: await idrp.totalSupply(),
      depository: await idrp.balanceOf(depository.address),
      holder: await idrp.balanceOf(holder.address),
      depositoryWallet: await idrp.depositoryWallet(),
      name: await idrp.name(),
      symbol: await idrp.symbol(),
      decimals: await idrp.decimals(),
      permitDomain: await idrp.DOMAIN_SEPARATOR(),
    };

    const v3 = await migrate(idrp, admin, controller.address);

    expect(await v3.totalSupply()).to.equal(before.supply);
    expect(await v3.balanceOf(depository.address)).to.equal(before.depository);
    expect(await v3.balanceOf(holder.address)).to.equal(before.holder);
    expect(await v3.depositoryWallet()).to.equal(before.depositoryWallet);
    expect(await v3.name()).to.equal(before.name);
    expect(await v3.symbol()).to.equal(before.symbol);
    expect(await v3.decimals()).to.equal(before.decimals);
    // Permit signatures outlive the migration only if this is unchanged.
    expect(await v3.DOMAIN_SEPARATOR()).to.equal(before.permitDomain);
    // The freeze survives — a sanctioned account must not be unfrozen by an upgrade.
    expect(await v3.frozen(frozen.address)).to.equal(true);
  });

  it("moves mint authority from MINTER_ROLE to the controller", async function () {
    const { idrp, admin, minter, controller } =
      await loadFixture(seededV2Fixture);

    const v3 = await migrate(idrp, admin, controller.address);

    expect(await v3.controller()).to.equal(controller.address);
    expect(await v3.admin()).to.equal(admin.address);

    // The old holder of MINTER_ROLE can no longer mint: v3 reads `controller`,
    // not the role. Passing the wrong address to initializeV3 would strand
    // minting entirely, which is why it must be the real controller proxy.
    await expect(v3.connect(minter).mint(AMOUNT)).to.be.reverted;
    await expect(v3.connect(controller).mint(AMOUNT)).to.not.be.reverted;
  });

  it("can still be upgraded afterwards", async function () {
    const { idrp, admin, controller } = await loadFixture(seededV2Fixture);

    const v3 = await migrate(idrp, admin, controller.address);

    const next = await (await hre.ethers.getContractFactory("IDRP")).deploy();
    await next.waitForDeployment();
    const nextAddress = await next.getAddress();

    await v3.connect(admin).scheduleUpgrade(nextAddress);
    await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine", []);
    await expect(v3.connect(admin).upgradeTo(nextAddress)).to.not.be.reverted;
  });

  it("hands admin and upgrader over after the migration, and the new upgrader upgrades twice more", async function () {
    const { idrp, admin, depository, holder, frozen, controller } =
      await loadFixture(seededV2Fixture);
    const [, , , , , , newAdmin, newUpgrader] = await hre.ethers.getSigners();

    const v3: any = await migrate(idrp, admin, controller.address);
    const before = {
      supply: await v3.totalSupply(),
      depository: await v3.balanceOf(depository.address),
      holder: await v3.balanceOf(holder.address),
      permitDomain: await v3.DOMAIN_SEPARATOR(),
    };

    // A v2 proxy with history arrives with nothing pending.
    expect(await v3.pendingAdmin()).to.deep.equal([hre.ethers.ZeroAddress, 0n]);
    expect(await v3.pendingUpgrader()).to.deep.equal([hre.ethers.ZeroAddress, 0n]);

    await v3.connect(admin).beginAdminTransfer(newAdmin.address);
    await v3.connect(admin).beginUpgraderTransfer(newUpgrader.address);
    await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine", []);
    await v3.connect(newAdmin).acceptAdminTransfer();
    await v3.connect(newUpgrader).acceptUpgraderTransfer();

    // OZ 4 build: upgradeTo, never upgradeToAndCall(impl, "0x").
    for (let hop = 0; hop < 2; hop++) {
      const next = await (await hre.ethers.getContractFactory("IDRP")).deploy();
      await next.waitForDeployment();
      await v3.connect(newUpgrader).scheduleUpgrade(await next.getAddress());
      await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine", []);
      await v3.connect(newUpgrader).upgradeTo(await next.getAddress());
      expect(
        await hre.upgrades.erc1967.getImplementationAddress(await v3.getAddress())
      ).to.equal(await next.getAddress());
    }

    await expect(
      v3.connect(admin).scheduleUpgrade(admin.address)
    ).to.be.revertedWithCustomError(v3, "NotUpgrader");
    expect(await v3.admin()).to.equal(newAdmin.address);
    expect(await v3.totalSupply()).to.equal(before.supply);
    expect(await v3.balanceOf(depository.address)).to.equal(before.depository);
    expect(await v3.balanceOf(holder.address)).to.equal(before.holder);
    expect(await v3.DOMAIN_SEPARATOR()).to.equal(before.permitDomain);
    expect(await v3.frozen(frozen.address)).to.equal(true);
  });
});

import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  takeSnapshot,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * The upgrade the four EVM mainnet tokens take: from the v3 implementation they
 * run today (contracts/legacy/IDRPv3.sol) to the handover build, as a plain
 * upgradeToAndCall(impl, "0x") with no initializer.
 *
 * What would make these fail: a moved or added sequential variable, handover
 * state that is not zero on a proxy with history, any loss of token state, a
 * proxy that stops accepting upgrades once authority has changed hands, or an
 * implementation too large for an EVM chain to accept.
 */
describe("Token upgrade path: live v3 → handover build", function () {
  const DELAY = 48n * 60n * 60n;
  const EIP170_LIMIT = 24_576;
  const AMOUNT = hre.ethers.parseUnits("1000000", 6);

  // These tests move the chain clock by days. Put it back afterwards: suites
  // that run later build their deadlines from wall-clock time.
  let untouched: Awaited<ReturnType<typeof takeSnapshot>>;
  before(async () => {
    untouched = await takeSnapshot();
  });
  after(async () => {
    await untouched.restore();
  });

  function storageLayout(source: string, name: string) {
    return hre.artifacts.getBuildInfo(`${source}:${name}`).then((info) => {
      const layout = (info!.output.contracts as any)[source][name].storageLayout;
      // AST ids inside type names differ between compilations of different
      // contracts; the shape is what has to match.
      return layout.storage.map((s: any) => ({
        label: s.label,
        slot: s.slot,
        offset: s.offset,
        type: String(s.type).replace(/\)\d+_/g, ")_"),
      }));
    });
  }

  async function seededV3Fixture() {
    const [admin, controller, depository, holder, spender, frozen, newAdmin, newUpgrader] =
      await hre.ethers.getSigners();

    const V3 = await hre.ethers.getContractFactory("IDRPv3");
    const idrp: any = await hre.upgrades.deployProxy(V3, [admin.address], { kind: "uups" });
    await idrp.waitForDeployment();

    const list = await (await hre.ethers.getContractFactory("SanctionsList")).deploy();
    await idrp.connect(admin).setController(controller.address);
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setMaxSupply(AMOUNT * 10n);
    await idrp.connect(admin).setSanctionsList(await list.getAddress());

    await idrp.connect(controller).mint(AMOUNT);
    await idrp.connect(depository).transfer(holder.address, AMOUNT / 4n);
    await idrp.connect(controller).freeze(frozen.address);

    // One spent permit, so the nonce is non-zero.
    const { chainId } = await hre.ethers.provider.getNetwork();
    const deadline = BigInt((await time.latest()) + 3600);
    const sig = hre.ethers.Signature.from(
      await holder.signTypedData(
        { name: "IDRP", version: "1", chainId, verifyingContract: await idrp.getAddress() },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { owner: holder.address, spender: spender.address, value: 5n, nonce: 0n, deadline }
      )
    );
    await idrp.permit(holder.address, spender.address, 5n, deadline, sig.v, sig.r, sig.s);

    return { idrp, admin, controller, depository, holder, spender, frozen, newAdmin, newUpgrader };
  }

  async function snapshot(idrp: any, s: any) {
    return {
      totalSupply: await idrp.totalSupply(),
      depositoryBalance: await idrp.balanceOf(s.depository.address),
      holderBalance: await idrp.balanceOf(s.holder.address),
      allowance: await idrp.allowance(s.holder.address, s.spender.address),
      nonce: await idrp.nonces(s.holder.address),
      frozen: await idrp.frozen(s.frozen.address),
      depositoryWallet: await idrp.depositoryWallet(),
      maxSupply: await idrp.maxSupply(),
      sanctionsList: await idrp.sanctionsList(),
      admin: await idrp.admin(),
      upgrader: await idrp.upgrader(),
      controller: await idrp.controller(),
      domainSeparator: await idrp.DOMAIN_SEPARATOR(),
      name: await idrp.name(),
      symbol: await idrp.symbol(),
      decimals: await idrp.decimals(),
      paused: await idrp.paused(),
    };
  }

  async function upgradeTo(idrp: any, upgrader: any, factoryName: string) {
    const impl = await (await (await hre.ethers.getContractFactory(factoryName)).deploy()).getAddress();
    await idrp.connect(upgrader).scheduleUpgrade(impl);
    await time.increase(DELAY + 1n);
    await idrp.connect(upgrader).upgradeToAndCall(impl, "0x");
    expect(await hre.upgrades.erc1967.getImplementationAddress(await idrp.getAddress())).to.equal(impl);
    return hre.ethers.getContractAt("IDRP", await idrp.getAddress()) as Promise<any>;
  }

  it("keeps the sequential storage layout identical, entry for entry", async function () {
    const before = await storageLayout("contracts/legacy/IDRPv3.sol", "IDRPv3");
    const after = await storageLayout("contracts/IDRP.sol", "IDRP");
    expect(after).to.deep.equal(before);
    expect(after.at(-1)).to.include({ label: "controller" });
  });

  it("passes OpenZeppelin's upgrade validation from the live v3 source", async function () {
    await hre.upgrades.validateUpgrade(
      await hre.ethers.getContractFactory("IDRPv3"),
      await hre.ethers.getContractFactory("IDRP"),
      { kind: "uups" }
    );
  });

  it("keeps every piece of token state across upgradeToAndCall(impl, \"0x\"), with nothing pending", async function () {
    const s = await loadFixture(seededV3Fixture);
    const before = await snapshot(s.idrp, s);

    const idrp = await upgradeTo(s.idrp, s.admin, "IDRP");

    expect(await snapshot(idrp, s)).to.deep.equal(before);
    expect(await idrp.pendingAdmin()).to.deep.equal([hre.ethers.ZeroAddress, 0n]);
    expect(await idrp.pendingUpgrader()).to.deep.equal([hre.ethers.ZeroAddress, 0n]);

    // Still a working token: the freeze still bites, the controller still mints.
    await expect(
      idrp.connect(s.holder).transfer(s.frozen.address, 1n)
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
    await idrp.connect(s.controller).mint(1n);
    expect(await idrp.totalSupply()).to.equal(before.totalSupply + 1n);
  });

  it("completes both handovers after the upgrade, and the new upgrader upgrades twice more", async function () {
    const s = await loadFixture(seededV3Fixture);
    const before = await snapshot(s.idrp, s);
    let idrp = await upgradeTo(s.idrp, s.admin, "IDRP");

    await idrp.connect(s.admin).beginUpgraderTransfer(s.newUpgrader.address);
    await idrp.connect(s.admin).beginAdminTransfer(s.newAdmin.address);
    await time.increase(DELAY + 1n);
    await idrp.connect(s.newUpgrader).acceptUpgraderTransfer();
    await idrp.connect(s.newAdmin).acceptAdminTransfer();
    expect(await idrp.admin()).to.equal(s.newAdmin.address);
    expect(await idrp.upgrader()).to.equal(s.newUpgrader.address);

    // Two more hops: one successful upgrade after a change is not proof of
    // permanence. Fresh implementations each time.
    idrp = await upgradeTo(idrp, s.newUpgrader, "IDRP");
    idrp = await upgradeTo(idrp, s.newUpgrader, "IDRP");

    const after = await snapshot(idrp, s);
    expect({ ...after, admin: before.admin, upgrader: before.upgrader }).to.deep.equal(before);
    expect(await idrp.pendingAdmin()).to.deep.equal([hre.ethers.ZeroAddress, 0n]);
    expect(await idrp.pendingUpgrader()).to.deep.equal([hre.ethers.ZeroAddress, 0n]);
    await expect(idrp.connect(s.admin).scheduleUpgrade(s.admin.address)).to.be.revertedWithCustomError(
      idrp,
      "NotUpgrader"
    );
  });

  it("fits under the EVM contract size limit (EIP-170), token and controller", async function () {
    for (const name of ["IDRP", "IDRPController"]) {
      const { deployedBytecode } = await hre.artifacts.readArtifact(name);
      const size = (deployedBytecode.length - 2) / 2;
      console.log(`      ${name.padEnd(15)} runtime ${size} bytes (${((size / EIP170_LIMIT) * 100).toFixed(1)}% of 24,576)`);
      expect(size).to.be.lessThan(EIP170_LIMIT);
    }
  });
});

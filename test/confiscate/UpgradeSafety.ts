import hre from "hardhat";
import { expect } from "chai";

/**
 * Upgrade safety for the six live proxies (Ethereum, Polygon, BNB, Kaia,
 * Kairos, Tron).
 *
 * NOTE ON DEPLOYMENT: none of these chains currently has the v3 `admin` slot —
 * admin()/controller() revert on all four EVM mainnets, which still run the v2
 * AccessControl token. Confiscate is admin-gated, so it CANNOT be shipped to a
 * mainnet until v3 is deployed there AND `admin` is a Safe distinct from
 * `upgrader`. See the "Deployment blocker" section of the spec. These tests
 * cover layout safety only; they are not a deployment green light.
 */
describe("Confiscate — upgrade safety", function () {
  it("upgrades a live proxy without a layout conflict, preserving state", async function () {
    const [admin, depository, seizedFunds] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");

    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(hre.ethers.parseUnits("1000", 6));

    const supplyBefore = await idrp.totalSupply();

    // IDRP enforces a 48h scheduleUpgrade timelock on itself (UPGRADE_DELAY,
    // see scheduleUpgrade/_authorizeUpgrade in IDRP.sol) — that's orthogonal to
    // confiscate, but hre.upgrades.upgradeProxy() will otherwise revert with
    // "Upgrade not scheduled". Deploy the v3 impl first so we know its address
    // to schedule, then let upgradeProxy reuse it (OZ's plugin caches
    // implementations by bytecode hash, so this doesn't deploy twice).
    const proxyAddress = await idrp.getAddress();
    const newImpl = await hre.upgrades.prepareUpgrade(proxyAddress, IDRPFactory, {
      kind: "uups",
    });
    await idrp.connect(admin).scheduleUpgrade(newImpl as string);
    await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");

    const upgraded = await hre.upgrades.upgradeProxy(
      proxyAddress,
      IDRPFactory,
      { kind: "uups", unsafeSkipStorageCheck: false }
    );
    await upgraded.waitForDeployment();

    expect(await upgraded.admin()).to.equal(admin.address);
    expect(await upgraded.depositoryWallet()).to.equal(depository.address);
    expect(await upgraded.totalSupply()).to.equal(supplyBefore);
    expect(await upgraded.confiscationWallet()).to.equal(hre.ethers.ZeroAddress);
  });

  it("keeps confiscate inert on a proxy that has never configured a destination", async function () {
    // The upgrade path a live chain actually takes: new implementation lands,
    // confiscationWallet is still address(0), nothing is seizable until an
    // operator schedules a destination and waits out the 48h timelock.
    const [admin, depository, badActor] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(hre.ethers.parseUnits("1000", 6));
    await idrp.connect(depository).transfer(badActor.address, hre.ethers.parseUnits("1000", 6));
    await idrp.connect(admin).freeze(badActor.address);

    await expect(
      idrp.connect(admin).confiscate(badActor.address, hre.ethers.parseUnits("1", 6))
    ).to.be.revertedWithCustomError(idrp, "ConfiscationWalletNotSet");
  });
});

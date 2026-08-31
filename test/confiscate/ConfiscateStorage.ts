import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Storage-layout and declaration checks for the confiscation feature.
 *
 * The layout check is the important one: six live proxies (Ethereum, Polygon,
 * BNB, Kaia, Kairos, Tron) share this contract's storage. Every confiscation
 * variable must be APPENDED after `controller`; inserting or reordering one
 * would silently corrupt production state on upgrade.
 */
describe("Confiscate — storage layout and declarations", function () {
  async function deployFixture() {
    const [admin, depository, seizedFunds, alice] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);
    return { idrp, IDRPFactory, admin, depository, seizedFunds, alice };
  }

  it("exposes confiscationWallet, unset on a fresh deploy", async function () {
    const { idrp } = await loadFixture(deployFixture);
    expect(await idrp.confiscationWallet()).to.equal(hre.ethers.ZeroAddress);
  });

  it("exposes the pending-change slots, empty on a fresh deploy", async function () {
    const { idrp } = await loadFixture(deployFixture);
    expect(await idrp.pendingConfiscationWallet()).to.equal(hre.ethers.ZeroAddress);
    expect(await idrp.confiscationWalletScheduledAt()).to.equal(0n);
  });

  it("does NOT expose the internal bypass flag as a public getter", async function () {
    const { idrp } = await loadFixture(deployFixture);
    expect((idrp as any)._inConfiscation).to.equal(undefined);
  });

  it("keeps every pre-existing slot readable and correct", async function () {
    const { idrp, admin, depository } = await loadFixture(deployFixture);
    expect(await idrp.admin()).to.equal(admin.address);
    expect(await idrp.upgrader()).to.equal(admin.address);
    expect(await idrp.depositoryWallet()).to.equal(depository.address);
    expect(await idrp.maxSupply()).to.equal(0n);
    expect(await idrp.sanctionsList()).to.equal(hre.ethers.ZeroAddress);
    expect(await idrp.decimals()).to.equal(6);
  });

  it("is a layout-compatible upgrade of itself (append-only check)", async function () {
    const { idrp, IDRPFactory } = await loadFixture(deployFixture);
    await hre.upgrades.validateUpgrade(await idrp.getAddress(), IDRPFactory, {
      kind: "uups",
    });
  });
});

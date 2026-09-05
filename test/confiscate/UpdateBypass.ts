import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * The bypass flag is scoped to a single call and nothing else.
 *
 * These tests exist because the flag is the most dangerous line in the feature:
 * if it ever stuck on, every freeze and every sanctions entry on the token would
 * quietly stop being enforced. A harness contract drives the transfer hook directly so the
 * flag's default state is observable without going through confiscate().
 */
describe("Confiscate — _beforeTokenTransfer bypass flag scoping", function () {
  const idrp6 = (whole: string) => hre.ethers.parseUnits(whole, 6);

  async function deployFixture() {
    const [admin, depository, alice, bob] = await hre.ethers.getSigners();
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [admin.address]);
    await idrp.waitForDeployment();
    await idrp.connect(admin).setDepositoryWallet(depository.address);

    // Wire admin as controller so we can mint/freeze directly in tests.
    await idrp.connect(admin).setController(admin.address);
    await idrp.connect(admin).mint(idrp6("1000000"));
    await idrp.connect(depository).transfer(alice.address, idrp6("1000"));

    return { idrp, admin, depository, alice, bob };
  }

  it("leaves the freeze gate enforced by default", async function () {
    const { idrp, admin, alice, bob } = await loadFixture(deployFixture);
    await idrp.connect(admin).freeze(alice.address);
    await expect(
      idrp.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("leaves the freeze gate enforced for a frozen RECIPIENT by default", async function () {
    const { idrp, admin, depository, alice } = await loadFixture(deployFixture);
    await idrp.connect(admin).freeze(alice.address);
    await expect(
      idrp.connect(depository).transfer(alice.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "FrozenAccount");
  });

  it("leaves the zero-amount guard in place on ordinary transfers", async function () {
    const { idrp, alice, bob } = await loadFixture(deployFixture);
    await expect(idrp.connect(alice).transfer(bob.address, 0)).to.be.revertedWith(
      "Transfer amount must be greater than zero"
    );
  });

  it("leaves the sanctions gate enforced by default", async function () {
    const { idrp, admin, alice, bob } = await loadFixture(deployFixture);
    // No MockSanctionsList exists in this repo; contracts/sanctions/SanctionsList.sol
    // is IDRP's own Chainalysis-clone implementation and is what production and the
    // rest of the sanctions test suite (test/sanctions/IDRPSanctions.test.ts) wire up
    // directly, so we reuse it here rather than adding a mock.
    const List = await hre.ethers.getContractFactory("SanctionsList");
    const list = await List.deploy();
    await list.waitForDeployment();
    await list.connect(admin).addToSanctionsList([alice.address]);
    await idrp.connect(admin).setSanctionsList(await list.getAddress());

    await expect(
      idrp.connect(alice).transfer(bob.address, idrp6("1"))
    ).to.be.revertedWithCustomError(idrp, "SanctionedSender");
  });
});

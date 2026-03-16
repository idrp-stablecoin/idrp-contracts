import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { parseUnits } from "ethers";

describe("IDRP", function () {
  async function contractFixture() {
    const [defaultAdmin, user, depository, dojWallet, outsider] =
      await hre.ethers.getSigners();
    const IDRP = await hre.ethers.getContractFactory("IDRP");
    const contract = await hre.upgrades.deployProxy(IDRP, [
      await defaultAdmin.getAddress(),
    ]);
    await contract.waitForDeployment();

    await contract.connect(defaultAdmin).setDepositoryWallet(depository.address);

    return { contract, defaultAdmin, user, depository, dojWallet, outsider };
  }

  async function mintToUser(
    contract: any,
    admin: any,
    depository: any,
    user: any,
    amount: bigint,
  ) {
    await contract.connect(admin).mint(amount);
    await contract.connect(depository).transfer(user.address, amount);
  }

  describe("Deployment", function () {
    it("Should set the right name and symbol", async function () {
      const { contract } = await loadFixture(contractFixture);
      expect(await contract.name()).to.equal("IDRP");
      expect(await contract.symbol()).to.equal("IDRP");
    });

    it("Should grant SEIZER_ROLE to default admin", async function () {
      const { contract, defaultAdmin } = await loadFixture(contractFixture);
      expect(
        await contract.hasRole(await contract.SEIZER_ROLE(), defaultAdmin.address),
      ).to.equal(true);
    });
  });

  describe("Seize", function () {
    it("Should seize assets from a frozen wallet", async function () {
      const { contract, defaultAdmin, user, depository, dojWallet } =
        await loadFixture(contractFixture);
      const amount = parseUnits("1000000", 6);
      const courtOrderHash = hre.ethers.keccak256(
        hre.ethers.toUtf8Bytes("CourtOrder-001"),
      );

      await mintToUser(contract, defaultAdmin, depository, user, amount);
      await contract.connect(defaultAdmin).freeze(user.address);

      await expect(
        contract
          .connect(defaultAdmin)
          .seize(
            user.address,
            dojWallet.address,
            amount,
            "CASE-2026-001",
            courtOrderHash,
          ),
      )
        .to.emit(contract, "AssetsSeized")
        .withArgs(
          defaultAdmin.address,
          user.address,
          dojWallet.address,
          amount,
          "CASE-2026-001",
          courtOrderHash,
        );

      expect(await contract.balanceOf(user.address)).to.equal(0);
      expect(await contract.balanceOf(dojWallet.address)).to.equal(amount);
    });

    it("Should fail to seize if source account is not frozen", async function () {
      const { contract, defaultAdmin, user, depository, dojWallet } =
        await loadFixture(contractFixture);
      const amount = parseUnits("100", 6);

      await mintToUser(contract, defaultAdmin, depository, user, amount);

      await expect(
        contract
          .connect(defaultAdmin)
          .seize(
            user.address,
            dojWallet.address,
            amount,
            "CASE-2026-002",
            hre.ethers.ZeroHash,
          ),
      ).to.be.revertedWithCustomError(contract, "SourceAccountNotFrozen");
    });

    it("Should fail to seize if caller does not have SEIZER_ROLE", async function () {
      const { contract, defaultAdmin, user, depository, dojWallet, outsider } =
        await loadFixture(contractFixture);
      const amount = parseUnits("100", 6);

      await mintToUser(contract, defaultAdmin, depository, user, amount);
      await contract.connect(defaultAdmin).freeze(user.address);

      await expect(
        contract
          .connect(outsider)
          .seize(
            user.address,
            dojWallet.address,
            amount,
            "CASE-2026-003",
            hre.ethers.ZeroHash,
          ),
      ).to.be.rejected;
    });

    it("Should fail to seize to a frozen recipient", async function () {
      const { contract, defaultAdmin, user, depository, dojWallet } =
        await loadFixture(contractFixture);
      const amount = parseUnits("100", 6);

      await mintToUser(contract, defaultAdmin, depository, user, amount);
      await contract.connect(defaultAdmin).freeze(user.address);
      await contract.connect(defaultAdmin).freeze(dojWallet.address);

      await expect(
        contract
          .connect(defaultAdmin)
          .seize(
            user.address,
            dojWallet.address,
            amount,
            "CASE-2026-004",
            hre.ethers.ZeroHash,
          ),
      ).to.be.revertedWithCustomError(contract, "FrozenAccount");
    });
  });
});

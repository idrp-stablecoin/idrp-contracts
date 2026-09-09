import hre from "hardhat";
import { expect } from "chai";

/**
 * Does the Controller's v1 -> v2 migration MOVE storage?
 *
 * This exists because I nearly made the opposite mistake to the one before.
 * Having established that OZ's refusal of the TOKEN's v2 -> v3 was only a naming
 * objection, it is tempting to treat every refusal that way. It is not:
 *
 *   IDRPControllerV1Mock   idrpToken @ slot 301   (_owner @151, Ownable)
 *   IDRPControllerv2       idrpToken @ slot 251
 *   IDRPController (v3)    idrpToken @ slot 251
 *
 * v1 carried OwnableUpgradeable's 50 slots ahead of its own variables. Dropping
 * it pulls everything after up by 50. That is a REAL layout break, and the
 * validator refusing it is correct.
 */
describe("TRON controller — v1 -> v2 genuinely shifts storage", function () {
  it("moves idrpToken by 50 slots, so a direct v1 -> v2 upgrade corrupts it", async function () {
    const [deployer] = await hre.ethers.getSigners();

    const V1 = await hre.ethers.getContractFactory("IDRPControllerV1Mock");
    const token = await (await hre.ethers.getContractFactory("IDRP")).deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const proxy: any = await hre.upgrades.deployProxy(V1, [tokenAddr, deployer.address], {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call", "state-variable-immutable", "state-variable-assignment"],
    });
    await proxy.waitForDeployment();
    const addr = await proxy.getAddress();

    expect(await proxy.idrpToken(), "v1 should hold the token address").to.equal(tokenAddr);
    // Physically at slot 301 on v1.
    const at301 = await hre.ethers.provider.getStorage(addr, 301);
    expect(hre.ethers.getAddress("0x" + at301.slice(26))).to.equal(tokenAddr);
    // And slot 251 — where v2 will look — is empty.
    expect(await hre.ethers.provider.getStorage(addr, 251)).to.equal(hre.ethers.ZeroHash);

    // Upgrade v1 -> v2 WITHOUT the validator, exactly as the bypass helper would.
    const V2 = await hre.ethers.getContractFactory("IDRPControllerv2");
    const impl = await V2.deploy(); await impl.waitForDeployment();
    await (await proxy.upgradeTo(await impl.getAddress())).wait();

    const v2 = await hre.ethers.getContractAt("IDRPControllerv2", addr);
    // THE FINDING: v2 reads slot 251, which v1 never wrote.
    expect(
      await v2.idrpToken(),
      "if this equals the token address, the 50-slot shift is not real"
    ).to.equal(hre.ethers.ZeroAddress);

    // The value is not lost — it is stranded 50 slots away, unreachable.
    const stranded = await hre.ethers.provider.getStorage(addr, 301);
    expect(hre.ethers.getAddress("0x" + stranded.slice(26))).to.equal(tokenAddr);
  });

  it("the validator is RIGHT to refuse it — unlike the token's v2 -> v3", async function () {
    // Contrast, asserted so the two cases can never be conflated again.
    const V1 = await hre.ethers.getContractFactory("IDRPControllerV1Mock");
    const V2 = await hre.ethers.getContractFactory("IDRPControllerv2");
    let refused = false;
    try {
      await hre.upgrades.validateUpgrade(V1, V2, {
        kind: "uups",
        unsafeAllow: ["missing-initializer-call", "state-variable-immutable", "state-variable-assignment"],
      });
    } catch { refused = true; }
    expect(refused, "the validator no longer refuses controller v1 -> v2 — re-check the shift").to.equal(true);
  });
});

import hre from "hardhat";
import { expect } from "chai";

/**
 * Which chains can reach the placeholder-free layout by UPGRADING, and which
 * cannot — checked by the validator itself rather than by argument.
 *
 * The retired confiscation slots are deleted on this branch, not reserved. That
 * is a storage DELETION, and OpenZeppelin rejects deletions with no annotation
 * available to express them. The question that decides whether this design is
 * viable is therefore not "is deleting safe" (the fork experiment already
 * answered that) but "which real chains would the validator refuse".
 *
 * Answer, asserted below and matched against what is actually deployed:
 *
 *   4 EVM mainnets   run v3-without-confiscate  -> PASSES, upgrade normally
 *   Sepolia          runs v2                    -> PASSES, upgrade normally
 *   Tron             never had confiscate       -> its own OZ4 branch, clean
 *   Kairos + BaseSep ran the placeholder layout -> REJECTED, need fresh proxies
 *
 * So no chain needs `unsafeSkipStorageCheck` and no chain carries a dead slot.
 * The entire cost of the clean layout is two testnet redeploys.
 */
describe("Confiscate — upgrade paths into the placeholder-free layout", function () {
  async function validate(fromName: string) {
    const From = await hre.ethers.getContractFactory(fromName);
    const To = await hre.ethers.getContractFactory("IDRP");
    await hre.upgrades.validateUpgrade(From, To, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    });
  }

  it("PASSES from v3-without-confiscate — the four EVM mainnets' real path", async function () {
    await validate("IDRPv3NoConfiscate");
  });

  it("PASSES from v2 — Sepolia's path", async function () {
    await validate("IDRPv2");
  });

  it("PASSES from itself — a fresh proxy, and every upgrade after the first", async function () {
    await validate("IDRP");
  });

  it("is REJECTED from the placeholder layout — which is why Kairos and Base Sepolia get fresh proxies", async function () {
    // Not a defect: it is the validator correctly refusing a deletion. Asserted
    // so that if a future OZ release ever accepted it, this test fails loudly
    // and the two redeploys can be reconsidered rather than done from habit.
    let rejected = false;
    let message = "";
    try {
      await validate("IDRPWithRetiredSlots");
    } catch (e) {
      rejected = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(rejected, "the validator now ACCEPTS this — revisit the redeploy plan").to.equal(true);
    expect(message).to.match(/Deleted `__deprecated_/);
  });

  it("keeps the bypass flag on a byte that every deployed controller leaves clear", async function () {
    // The flag packs into `controller`'s slot at byte 20. That is only safe
    // because `controller` is a 20-byte address, so byte 20 is zero — verified
    // on-chain 2026-09-07 across Ethereum, Polygon, BNB, Kaia, Kairos and Base
    // Sepolia, all reading 0x00. This asserts the layout half of that pairing;
    // if the flag ever moved to byte 0 it would read a live address as `true`.
    const dbg = await hre.artifacts.readArtifact("IDRP");
    expect(dbg.contractName).to.equal("IDRP");

    const { storage } = await (async () => {
      const fs = await import("fs");
      const path = await import("path");
      const dbgPath = path.join(
        hre.config.paths.artifacts,
        "contracts/IDRP.sol/IDRP.dbg.json"
      );
      const d = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
      const bi = JSON.parse(
        fs.readFileSync(path.resolve(path.dirname(dbgPath), d.buildInfo), "utf8")
      );
      return bi.output.contracts["contracts/IDRP.sol"]["IDRP"].storageLayout;
    })();

    const flag = storage.find((v: any) => v.label === "_inConfiscation");
    const controller = storage.find((v: any) => v.label === "controller");
    expect(flag.slot).to.equal(controller.slot);
    expect(flag.offset).to.equal(20);
  });
});

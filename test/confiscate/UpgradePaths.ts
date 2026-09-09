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

  it("does NOT brick a placeholder proxy's future upgrades — a new feature still lands", async function () {
    // The question that actually matters for the two testnet proxies left on the
    // placeholder variant: can they still take the NEXT upgrade?
    //
    // Yes. A future feature appends at slot 12, after the three reserved slots,
    // and validates normally. Verified against the live Kairos and Base Sepolia
    // proxies too (2026-09-09). Staying on the placeholder variant costs three
    // slots; it does not close the door on anything.
    const From = await hre.ethers.getContractFactory("IDRPWithRetiredSlots");
    const To = await hre.ethers.getContractFactory("IDRPPlaceholderPlusFeature");
    await hre.upgrades.validateUpgrade(From, To, {
      kind: "uups",
      // Properties of the probe mock, not of the layout under test.
      unsafeAllow: ["missing-initializer", "missing-initializer-call"],
    });
  });

  it("does NOT brick a clean proxy's future upgrades either", async function () {
    const From = await hre.ethers.getContractFactory("IDRP");
    const To = await hre.ethers.getContractFactory("IDRPCleanPlusFeature");
    await hre.upgrades.validateUpgrade(From, To, {
      kind: "uups",
      unsafeAllow: ["missing-initializer", "missing-initializer-call"],
    });
  });

  it("is a TOKEN-only constraint — the Controller has no confiscation storage at all", async function () {
    // Worth asserting rather than assuming. Adding confiscate to the Controller
    // needed NO new storage: OperationType.Confiscate is an enum value, the
    // dispatch is code, and op 6's rules live inside the existing `quorumRules`
    // mapping at a keccak-derived slot. So the Controller's layout is untouched
    // by any of this, and every deployed controller — on both layout variants —
    // validates onto the current source.
    //
    // Measured 2026-09-09 against all four live controllers (Kairos + Base
    // Sepolia, old and new): 4/4 PASS, while the two old TOKENS are rejected.
    const fs = await import("fs");
    const path = await import("path");
    const dbgPath = path.join(
      hre.config.paths.artifacts,
      "contracts/IDRPController.sol/IDRPController.dbg.json"
    );
    const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
    const bi = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(dbgPath), dbg.buildInfo), "utf8")
    );
    const layout =
      bi.output.contracts["contracts/IDRPController.sol"]["IDRPController"].storageLayout;

    for (const v of layout.storage) {
      expect(v.label, `controller gained confiscation storage: ${v.label}`).to.not.match(
        /confiscat|__deprecated/i
      );
    }

    // And it upgrades onto itself cleanly, which is all any chain needs from it.
    const F = await hre.ethers.getContractFactory("IDRPController");
    await hre.upgrades.validateUpgrade(F, F, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    });
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

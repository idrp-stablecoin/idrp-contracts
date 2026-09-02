/**
 * Why TronGaplessUUPSUpgradeable exists, locked in as a test.
 *
 * The question "couldn't we just use stock UUPSUpgradeable?" is reasonable and will
 * be asked again. The answer is measured, not argued:
 *
 *   Controller — NO. v3 adds AccessControlDefaultAdminRules (50 slots that v2 did not
 *                have). Stock UUPS keeps its own trailing __gap[50] on top of that, so
 *                the contract's own variables land 50 slots too high: idrpToken at 301
 *                instead of the 251 the live Tron proxy uses. Dropping the UUPS gap
 *                trades those 50 back. Net zero.
 *
 *   Token      — not strictly. It removes AccessControl+ERC165 and reserves those
 *                slots explicitly, so stock UUPS would also land `frozen` on 504. It
 *                uses the same base for consistency, with __legacyTailGap[50] standing
 *                in for the removed UUPS gap.
 *
 * A 50-slot shift compiles cleanly and deploys cleanly. It only shows up as the
 * implementation reading unrelated storage, which is why this is a test and not a
 * comment.
 */
import { expect } from "chai";
import hre from "hardhat";

/** First slot of a contract's own (non-inherited) state, by variable name. */
async function slotOf(fqn: string, variable: string): Promise<number> {
  const [sourceName, contractName] = fqn.split(":");
  const info = await hre.artifacts.getBuildInfo(`${sourceName}:${contractName}`);
  if (!info) throw new Error(`no build info for ${fqn}`);
  const layout = (info.output.contracts as any)[sourceName][contractName].storageLayout;
  const entry = (layout.storage ?? []).find((s: any) => s.label === variable);
  if (!entry) throw new Error(`${variable} not found in ${fqn}`);
  return Number(entry.slot);
}

describe("UUPS base choice — storage layout", () => {
  // These are the slots the LIVE Tron mainnet proxies use. Read from chain, not source.
  const LIVE_CONTROLLER_IDRPTOKEN = 251;
  const LIVE_TOKEN_FROZEN = 504;

  it("deployed v2 sources sit where the live proxies say they do", async () => {
    expect(await slotOf("contracts/legacy/IDRPControllerv2.sol:IDRPControllerv2", "idrpToken"))
      .to.equal(LIVE_CONTROLLER_IDRPTOKEN);
    expect(await slotOf("contracts/legacy/IDRPv2.sol:IDRPv2", "frozen"))
      .to.equal(LIVE_TOKEN_FROZEN);
  });

  it("v3 Controller keeps idrpToken at 251 — this is what the gapless base buys", async () => {
    expect(await slotOf("contracts/IDRPController.sol:IDRPController", "idrpToken"))
      .to.equal(LIVE_CONTROLLER_IDRPTOKEN);
  });

  it("v3 token keeps frozen at 504", async () => {
    expect(await slotOf("contracts/IDRP.sol:IDRP", "frozen"))
      .to.equal(LIVE_TOKEN_FROZEN);
  });

  it("ACDAR occupies the 50 slots the UUPS gap gave up", async () => {
    // v2 had a plain __gap[50] at 151. v3 puts ACDAR's own state there instead, and
    // ERC1967Upgrade's gap moves to 201 — where v2's UUPS-adjacent gap used to be.
    const s = await slotOf("contracts/IDRPController.sol:IDRPController", "_pendingDefaultAdmin");
    expect(s).to.equal(151);
  });

  it("the token's __legacyTailGap stands in for the removed UUPS gap", async () => {
    // 454..503, immediately before `frozen` at 504.
    expect(await slotOf("contracts/IDRP.sol:IDRP", "__legacyTailGap")).to.equal(454);
    // and the 100 slots vacated by AccessControl+ERC165 stay reserved
    expect(await slotOf("contracts/IDRP.sol:IDRP", "__legacyAccessControlGap")).to.equal(201);
  });
});

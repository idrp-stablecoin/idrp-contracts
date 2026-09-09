import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * In-place removal of the retired confiscation slots on a TESTNET token proxy.
 *
 * ⚠️ THIS HOP DELIBERATELY FORGOES OZ'S STORAGE-LAYOUT CHECK.
 *
 * OpenZeppelin rejects the change — it is a declared-layout DELETION and there is
 * no annotation for one. This script upgrades through a plain factory and a
 * direct `upgradeToAndCall`, which never consults the validator, so no
 * `unsafeSkipStorageCheck` appears anywhere; the check is simply not in the path.
 * That is the same thing in substance, and it is only defensible because a
 * stronger, specific check was run in its place:
 *
 *   test/confiscate/RemovalExperiment.ts    — Kairos, on a fork of live state
 *   test/confiscate/BaseSepoliaRemoval.ts   — Base Sepolia, on a fork of live state
 *
 * Both perform this exact upgrade against the real deployed bytecode and then
 * check the freeze gate, a full seizure, supply, and what a newly appended
 * variable reads. Do not run this on a chain that has no such proof.
 *
 * `initializeV4()` is passed as the upgrade data ALWAYS, even where there is
 * nothing to scrub: the call consumes `reinitializer(4)`, and slots 9-11 are
 * free on the resulting layout, so leaving it live would let a later call zero a
 * future feature's storage.
 *
 * Usage:
 *   STEP=schedule npx hardhat run scripts/testnet-remove-retired-slots.ts --network baseSepolia
 *   # wait out the timelock, then
 *   STEP=execute  npx hardhat run scripts/testnet-remove-retired-slots.ts --network baseSepolia
 */

const IDRP_SOURCE = path.join(__dirname, "../contracts/IDRP.sol");
const CANONICAL = "    uint256 public constant UPGRADE_DELAY = 48 hours;";
const MAINNET_CHAIN_IDS = new Set([1, 56, 137, 8217]);
const ALLOWED = new Set([1001, 84532]);

async function withDelay<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const original = fs.readFileSync(IDRP_SOURCE, "utf8");
  if (!original.includes(CANONICAL)) throw new Error("contracts/IDRP.sol is not canonical");
  try {
    if (seconds !== 48 * 3600) {
      fs.writeFileSync(IDRP_SOURCE, original.replace(CANONICAL,
        `    uint256 public constant UPGRADE_DELAY = ${seconds} seconds;`));
      console.log(`  patched UPGRADE_DELAY -> ${seconds}s`);
    }
    await hre.run("compile", { force: true, quiet: true });
    return await fn();
  } finally {
    fs.writeFileSync(IDRP_SOURCE, original);
    if (fs.readFileSync(IDRP_SOURCE, "utf8") !== original) {
      throw new Error("FAILED TO RESTORE contracts/IDRP.sol");
    }
    console.log("  contracts/IDRP.sol restored to canonical 48h");
  }
}

async function main() {
  const step = process.env.STEP;
  if (step !== "schedule" && step !== "execute") throw new Error("set STEP=schedule|execute");
  const chainId = hre.network.config.chainId!;
  if (MAINNET_CHAIN_IDS.has(chainId)) throw new Error(`REFUSING: ${hre.network.name} is MAINNET`);
  if (!ALLOWED.has(chainId)) throw new Error(`REFUSING: chainId ${chainId} not allow-listed`);

  const file = path.join(__dirname, `../deployment/chain-${chainId}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  // The OLD proxy is the one carrying the retired slots.
  const proxy: string = d.IDRPPrevious ?? d.IDRP;

  const token = await hre.ethers.getContractAt("IDRP", proxy);
  const upgraderAddr = await token.upgrader();
  const signers = await hre.ethers.getSigners();
  const upgrader = signers.find((s) => s.address.toLowerCase() === upgraderAddr.toLowerCase());
  if (!upgrader) throw new Error(`no configured signer is upgrader ${upgraderAddr}`);
  const t = token.connect(upgrader) as any;

  const delay = await token.UPGRADE_DELAY();
  console.log(`network        ${hre.network.name} (${chainId}) TESTNET`);
  console.log(`token proxy    ${proxy}   <- the OLD, placeholder-variant proxy`);
  console.log(`current impl   ${await hre.upgrades.erc1967.getImplementationAddress(proxy)}`);
  console.log(`upgrader       ${upgrader.address}`);
  console.log(`UPGRADE_DELAY  ${delay}s`);
  for (const s of [9, 10, 11]) {
    const v = await hre.ethers.provider.getStorage(proxy, s);
    console.log(`slot ${s}         ${v === hre.ethers.ZeroHash ? "zero" : v + "  <- WILL BE SCRUBBED"}`);
  }

  if (step === "schedule") {
    const pending = await token.scheduledImplementation();
    if (pending !== hre.ethers.ZeroAddress) {
      console.log(`\nAlready scheduled: ${pending}. Run STEP=execute.`);
      return;
    }
    const seconds = Number(process.env.IMPL_UPGRADE_DELAY ?? delay);
    const impl = await withDelay(seconds, async () => {
      const F = await hre.ethers.getContractFactory("IDRP", upgrader);
      const c = await F.deploy();
      await c.waitForDeployment();
      const a = await c.getAddress();
      const got = await (c as any).UPGRADE_DELAY();
      if (Number(got) !== seconds) throw new Error(`impl UPGRADE_DELAY=${got}, expected ${seconds}`);
      console.log(`  implementation ${a} (UPGRADE_DELAY ${got}s)`);
      return a;
    });
    const tx = await t.scheduleUpgrade(impl);
    await tx.wait();
    const at = await token.upgradeScheduledAt();
    console.log(`\nscheduled       ${tx.hash}`);
    console.log(`executable after ${at + delay}`);
    d.IDRPRemovalScheduledImpl = impl;
    d.IDRPRemovalExecutableAfter = (at + delay).toString();
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    return;
  }

  // ── execute ───────────────────────────────────────────────────────────────
  const scheduled: string = await token.scheduledImplementation();
  if (scheduled === hre.ethers.ZeroAddress) return console.log("\nNothing scheduled.");
  const at = await token.upgradeScheduledAt();
  const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
  if (now < at + delay) {
    const r = Number(at + delay - now);
    return console.log(`\nToo early — ${Math.floor(r / 60)}m ${r % 60}s remaining.`);
  }

  const pre = {
    admin: await token.admin(), upgrader: await token.upgrader(),
    controller: await token.controller(), depository: await token.depositoryWallet(),
    supply: await token.totalSupply(),
  };

  const F = await hre.ethers.getContractFactory("IDRP");
  const data = F.interface.encodeFunctionData("initializeV4", []);
  console.log(`\nExecuting upgradeToAndCall(${scheduled}, initializeV4())...`);
  const tx = await t.upgradeToAndCall(scheduled, data);
  await tx.wait();
  console.log(`  tx ${tx.hash}`);

  const checks: Array<[string, boolean, string]> = [
    ["impl swapped", (await hre.upgrades.erc1967.getImplementationAddress(proxy)).toLowerCase() === scheduled.toLowerCase(), scheduled],
    ["admin preserved", (await token.admin()) === pre.admin, pre.admin],
    ["upgrader preserved", (await token.upgrader()) === pre.upgrader, pre.upgrader],
    ["controller preserved", (await token.controller()) === pre.controller, pre.controller],
    ["depository preserved", (await token.depositoryWallet()) === pre.depository, pre.depository],
    ["supply preserved", (await token.totalSupply()) === pre.supply, pre.supply.toString()],
    ["slot 9 scrubbed", (await hre.ethers.provider.getStorage(proxy, 9)) === hre.ethers.ZeroHash, ""],
    ["slot 10 scrubbed", (await hre.ethers.provider.getStorage(proxy, 10)) === hre.ethers.ZeroHash, ""],
    ["slot 11 scrubbed", (await hre.ethers.provider.getStorage(proxy, 11)) === hre.ethers.ZeroHash, ""],
  ];
  console.log("\nPost-upgrade checks:");
  let ok = true;
  for (const [l, pass, detail] of checks) { console.log(`  ${pass ? "OK  " : "FAIL"}  ${l.padEnd(22)} ${detail}`); if (!pass) ok = false; }

  // reinitializer(4) must now be consumed — a replay has to fail.
  let replayBlocked = false;
  try { await t.initializeV4.staticCall(); } catch { replayBlocked = true; }
  console.log(`  ${replayBlocked ? "OK  " : "FAIL"}  initializeV4 consumed`);
  if (!replayBlocked) ok = false;

  delete d.IDRPRemovalScheduledImpl; delete d.IDRPRemovalExecutableAfter;
  d.IDRPPreviousImpl = scheduled;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  if (!ok) throw new Error("POST-UPGRADE CHECKS FAILED");
  console.log("\nAll post-upgrade checks passed.");
}

main().catch((e) => { console.error("\n" + (e.message ?? e)); process.exitCode = 1; });

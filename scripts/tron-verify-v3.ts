/**
 * Snapshot the Controller / Token around the v3 upgrade, and compare. Read-only.
 *
 *   TARGET=controller npx hardhat run scripts/tron-verify-v3.ts --network tron   (or nile | tre)
 *   TARGET=token      npx hardhat run scripts/tron-verify-v3.ts --network tron
 *
 *   SNAPSHOT=before-token.json   writes what it read (run this BEFORE the upgrade)
 *   BASELINE=before-token.json   compares with that file and fails on any difference the
 *                                upgrade must not cause (run this AFTER)
 *   CHECK_ACCOUNTS=T…,T…         token: also balanceOf / frozen / nonces for these accounts
 *                                (e.g. every frozen account)
 *
 * What it checks every time: the implementation, the upgrader, the pending schedule, the
 * quorum signers' roles (controller), both TronUUPS slots (any non-zero value means future
 * upgrades revert), and the upgrade path: upgradeTo is simulated from the upgrader and must
 * stop at the timelock check ("Upgrade not scheduled" / "Timelock not expired"), which
 * proves the UUPS proxy gate still passes.
 *
 * What may differ from the baseline after the upgrade: the implementation, the cleared
 * schedule, and getters that only exist on v3. Everything else (supply, balances, frozen
 * flags, the permit domain, the signing digest, the quorum rules and roles) must be equal.
 *
 * Every read is a raw call and every transport failure throws: a read that cannot be
 * completed is never reported as a value.
 */
import fs from "fs";
import path from "path";
import hre from "hardhat";
import { ethers } from "ethers";
import { tronNetwork, base58Of, hexOf, type TronNet } from "./utils/tron-network";
import { ethCall, getStorage } from "./utils/tron-preflight";
import { IMPL_SLOT } from "./utils/tron-impl";
import { DEFAULT_ADMIN_ROLE, PROXY_SLOT_NAMES, quorumRolesHeld, upgradeGateHealthy } from "./utils/tron-steps";

type Snap = Record<string, string>;

const RULE_FILES: Array<[number, string, string]> = [
  [0, "Mint", "rules.mint.burn.json"],
  [1, "Burn", "rules.mint.burn.json"],
  [2, "Freeze", "rules.freeze.unfreeze.json"],
  [3, "Unfreeze", "rules.freeze.unfreeze.json"],
  [4, "Pause", "rules.pause.json"],
  [5, "Unpause", "rules.unpause.json"],
];

/** Keys the upgrade is expected to change. */
const MAY_CHANGE = new Set(["implementation", "scheduledImplementation()", "upgradeScheduledAt()"]);

async function read(net: TronNet, toHex: string, signature: string, args: unknown[] = []): Promise<string> {
  const ifc = new ethers.Interface([`function ${signature}`]);
  const fn = ifc.fragments[0] as ethers.FunctionFragment;
  const out = await ethCall(net, toHex, ifc.encodeFunctionData(fn, args));
  if (out === null || out === "0x") return "(reverts)";
  const r = ifc.decodeFunctionResult(fn, out);
  return JSON.stringify(r.length === 1 ? r[0] : [...r], (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function snapController(net: TronNet): Promise<Snap> {
  const c = hexOf(net, net.controller);
  const s: Snap = {};
  s.implementation = "0x" + (await getStorage(net, c, IMPL_SLOT)).slice(-40).toLowerCase();
  for (const g of ["upgrader() view returns (address)", "idrpToken() view returns (address)", "scheduledImplementation() view returns (address)",
    "upgradeScheduledAt() view returns (uint256)", "UPGRADE_DELAY() view returns (uint256)", "nonce() view returns (uint256)",
    "defaultAdmin() view returns (address)", "defaultAdminDelay() view returns (uint48)", "pendingDefaultAdmin() view returns (address,uint48)"]) {
    s[g.split(" ")[0]] = await read(net, c, g);
  }
  const probe = ["0x000000000000000000000000000000000000dEaD", 0, 1n, "tron-verify-v3 probe", 1n];
  s["getOperationHash(probe)"] = await read(net, c, "getOperationHash(address,uint8,uint256,string,uint256) view returns (bytes32)", probe);
  const upgrader = JSON.parse(s["upgrader()"]);
  s["hasRole(DEFAULT_ADMIN, upgrader)"] = await read(net, c, "hasRole(bytes32,address) view returns (bool)", [DEFAULT_ADMIN_ROLE, upgrader]);
  for (const [op, name, file] of RULE_FILES) {
    const tiers = JSON.parse(fs.readFileSync(path.join(hre.config.paths.root, "test/utils", file), "utf8"));
    for (const t of tiers) {
      s[`getQuorumRule(${name}, ${t.minAmount})`] = await read(net, c,
        "getQuorumRule(uint8,uint256) view returns ((uint256 minAmount,uint256 maxAmount,bytes32[] requiredRoles))", [op, BigInt(t.minAmount)]);
    }
  }
  const q = await quorumRolesHeld(net);
  for (const l of q.lines) s[`role ${l.split(/\s+/).slice(0, 2).join(" ")}`] = l.endsWith("✓") ? "held" : "MISSING";
  for (const n of PROXY_SLOT_NAMES) s[n] = await getStorage(net, c, ethers.id(n));
  return s;
}

async function snapToken(net: TronNet): Promise<Snap> {
  const t = hexOf(net, net.token);
  const s: Snap = {};
  s.implementation = "0x" + (await getStorage(net, t, IMPL_SLOT)).slice(-40).toLowerCase();
  for (const g of ["upgrader() view returns (address)", "scheduledImplementation() view returns (address)", "upgradeScheduledAt() view returns (uint256)",
    "UPGRADE_DELAY() view returns (uint256)", "name() view returns (string)", "symbol() view returns (string)", "decimals() view returns (uint8)",
    "totalSupply() view returns (uint256)", "DOMAIN_SEPARATOR() view returns (bytes32)", "paused() view returns (bool)",
    "depositoryWallet() view returns (address)", "maxSupply() view returns (uint256)", "sanctionsList() view returns (address)",
    "admin() view returns (address)", "controller() view returns (address)", "pendingAdmin() view returns (address,uint48)",
    "pendingUpgrader() view returns (address,uint48)", "AUTHORITY_TRANSFER_DELAY() view returns (uint48)"]) {
    s[g.split(" ")[0]] = await read(net, t, g);
  }
  const depository = JSON.parse(s["depositoryWallet()"]);
  const accounts = new Set<string>([depository.toLowerCase(), hexOf(net, net.controller)]);
  for (const a of (process.env.CHECK_ACCOUNTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) accounts.add(hexOf(net, a));
  for (const a of accounts) {
    const label = base58Of(net, a);
    s[`balanceOf(${label})`] = await read(net, t, "balanceOf(address) view returns (uint256)", [a]);
    s[`frozen(${label})`] = await read(net, t, "frozen(address) view returns (bool)", [a]);
    s[`nonces(${label})`] = await read(net, t, "nonces(address) view returns (uint256)", [a]);
  }
  for (const n of PROXY_SLOT_NAMES) s[n] = await getStorage(net, t, ethers.id(n));
  return s;
}

async function main() {
  const target = (process.env.TARGET ?? "").toLowerCase();
  if (target !== "controller" && target !== "token") throw new Error(`Set TARGET=controller or TARGET=token`);
  const net = await tronNetwork(hre);
  const proxy = target === "controller" ? net.controller : net.token;
  console.log(`\n${"━".repeat(78)}\n${target === "controller" ? "IDRPController" : "IDRP token"}   ${proxy}   (${net.name} — ${net.label})\n${"━".repeat(78)}`);

  const snap = target === "controller" ? await snapController(net) : await snapToken(net);
  const width = Math.max(...Object.keys(snap).map((k) => k.length));
  for (const [k, v] of Object.entries(snap)) console.log(`  ${k.padEnd(width)}  ${v}`);

  let bad = 0;
  if (target === "controller") {
    const q = await quorumRolesHeld(net);
    console.log(`\n  quorum roles: ${q.held}/${q.total} held`);
    if (q.held !== q.total) bad++;
  }
  for (const n of PROXY_SLOT_NAMES) {
    if (!/^0x0*$/.test(snap[n])) {
      console.log(`  ✗ ${n} is SET — future upgrades will revert. Investigate immediately.`);
      bad++;
    }
  }
  try {
    console.log(`\n  upgrade path (simulated from the upgrader, nothing sent): "${await upgradeGateHealthy(net, target)}" — the UUPS proxy gate passes ✓`);
  } catch (e: any) {
    console.log(`\n  ✗ upgrade path: ${e.message}`);
    bad++;
  }

  if (process.env.SNAPSHOT) {
    fs.writeFileSync(process.env.SNAPSHOT, JSON.stringify({ network: net.name, proxy, at: new Date().toISOString(), snap }, null, 2) + "\n");
    console.log(`\n  snapshot written to ${process.env.SNAPSHOT}`);
  }
  if (process.env.BASELINE) {
    const base = JSON.parse(fs.readFileSync(process.env.BASELINE, "utf8"));
    if (base.proxy !== proxy || base.network !== net.name) throw new Error(`${process.env.BASELINE} is a snapshot of ${base.proxy} on ${base.network}`);
    console.log(`\n  compared with ${process.env.BASELINE} (${base.at}):`);
    let diffs = 0;
    for (const [k, before] of Object.entries(base.snap as Snap)) {
      const after = snap[k];
      if (after === before) continue;
      const expected = MAY_CHANGE.has(k) || before === "(reverts)";
      if (!expected) diffs++;
      console.log(`    ${expected ? "~" : "✗"} ${k}\n        before ${before}\n        after  ${after ?? "(not read)"}`);
    }
    console.log(diffs ? `  ✗ ${diffs} unexpected difference(s)` : `  ✓ nothing changed that the upgrade must not change`);
    bad += diffs;
  }
  if (bad) process.exitCode = 1;
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

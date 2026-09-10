/**
 * Nile: enumerate every current DEFAULT_ADMIN_ROLE holder on the Controller.
 *
 *   npx hardhat run scripts/nile-list-default-admin-holders.ts --network nile
 *
 * Read-only. Writes deployment/nile-legacy-default-admin-holders.json.
 *
 * WHY THIS MATTERS
 *   `initializeV3(_admin, _upgrader, _legacyDefaultAdminHolders)` revokes exactly
 *   the addresses handed to it, then hands DEFAULT_ADMIN to a single ACDAR admin.
 *   Any legacy holder missing from that array KEEPS DEFAULT_ADMIN_ROLE after the
 *   upgrade — a hidden admin surviving the migration. The list must be COMPLETE,
 *   so this must not be allowed to silently under-report.
 *
 * WHY NOT scripts/tron-list-default-admin-holders.ts
 *   That one is hard-guarded to mainnet and walks eth_getLogs in 5000-block
 *   chunks — TronGrid's hard limit. Nile produces a block every ~3s, so covering
 *   the contract's whole life that way is thousands of requests and will be rate
 *   limited into an incomplete answer, which is the one failure mode that matters
 *   here. TronGrid's event index is queried by contract instead, so completeness
 *   does not depend on guessing a start block.
 *
 *   Every candidate is then confirmed with a live `hasRole` call, so addresses
 *   that were granted and later revoked drop out on their own.
 */
import fs from "fs";
import path from "path";
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://nile.trongrid.io";
const PROXY = "TWTjirsqPT6DGC63RMSAHGtb2NdzauiJWy";
const DEFAULT_ADMIN_ROLE = "0x" + "0".repeat(64);

const ABI = [
  { inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    name: "hasRole", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
];

async function main() {
  if (hre.network.name !== "nile") throw new Error(`Nile only (got ${hre.network.name})`);
  const tw = new TronWeb({ fullHost: HOST });
  tw.setAddress(PROXY);

  // ── Enumerate candidates ─────────────────────────────────────────────────
  //
  // Two steps, because neither source is sufficient alone:
  //
  //  1. TronGrid's event index lists every event the contract ever emitted, but
  //     returns `result: {}` for them — the ABI is not registered for Nile, so it
  //     cannot decode parameters. Taking that at face value reports ZERO holders
  //     and would hand an empty array to initializeV3, leaving every legacy admin
  //     alive. It is used ONLY to learn which blocks to look at.
  //  2. eth_getLogs on those specific blocks returns the raw topics, which decode
  //     locally. Bounded to the blocks that actually contain events, so this is
  //     ~dozens of requests rather than a 5000-block walk over the chain's life.
  const ROLE_GRANTED = hre.ethers.id("RoleGranted(bytes32,address,address)")
  const ROLE_REVOKED = hre.ethers.id("RoleRevoked(bytes32,address,address)")

  const blocks = new Set<number>()
  let pages = 0, events = 0, roleEvents = 0, fingerprint: string | undefined
  for (;;) {
    const url = new URL(`${HOST}/v1/contracts/${PROXY}/events`)
    url.searchParams.set("limit", "200")
    url.searchParams.set("order_by", "block_timestamp,asc")
    if (fingerprint) url.searchParams.set("fingerprint", fingerprint)
    const res = await fetch(url).then((r) => r.json() as any)
    if (!res.success) throw new Error(`event index error: ${JSON.stringify(res).slice(0, 200)}`)
    const data: any[] = res.data ?? []
    for (const e of data) {
      events++
      if (e.event_name === "RoleGranted" || e.event_name === "RoleRevoked") {
        roleEvents++
        blocks.add(Number(e.block_number))
      }
    }
    pages++
    fingerprint = res.meta?.fingerprint
    if (!fingerprint || data.length === 0) break
    if (pages > 200) throw new Error("pagination did not terminate — refusing to report a partial list")
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`event index: ${events} event(s), ${roleEvents} role event(s) across ${blocks.size} block(s)`)
  if (roleEvents === 0) {
    throw new Error(
      "no RoleGranted/RoleRevoked found at all. A deployed AccessControl contract " +
      "always grants at least one admin, so this is an indexing failure, not an " +
      "empty set. Do NOT proceed to initializeV3 on this result.",
    )
  }

  // Pull the raw topics for exactly those blocks and decode locally.
  const seen = new Set<string>()
  for (const b of [...blocks].sort((x, y) => x - y)) {
    const res = await fetch(`${HOST}/jsonrpc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{
        address: "0x" + tw.address.toHex(PROXY).slice(2),
        fromBlock: "0x" + b.toString(16), toBlock: "0x" + b.toString(16),
      }]}),
    }).then((r) => r.json() as any)
    for (const log of res.result ?? []) {
      const t: string[] = log.topics ?? []
      if (t.length < 3) continue
      if (t[0].toLowerCase() !== ROLE_GRANTED && t[0].toLowerCase() !== ROLE_REVOKED) continue
      if (t[1].toLowerCase() !== DEFAULT_ADMIN_ROLE) continue
      seen.add(hre.ethers.getAddress("0x" + t[2].slice(26)))
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`DEFAULT_ADMIN_ROLE candidates: ${seen.size}`)
  if (seen.size === 0) {
    throw new Error("role events exist but none touched DEFAULT_ADMIN_ROLE — investigate before proceeding")
  }

  // ── Confirm each against live state ───────────────────────────────────────
  const c = await tw.contract(ABI, PROXY);
  const holders: string[] = [];
  for (const cand of seen) {
    const hex = cand.startsWith("0x") ? cand : "0x" + tw.address.toHex(cand).slice(2);
    const has: boolean = await c.hasRole(DEFAULT_ADMIN_ROLE, hex).call();
    console.log(`  ${has ? "HOLDS " : "no    "} ${cand}  ${hex}`);
    if (has) holders.push(hex);
    await new Promise((r) => setTimeout(r, 250));
  }

  const out = path.join(__dirname, "../deployment/nile-legacy-default-admin-holders.json");
  fs.writeFileSync(out, JSON.stringify(holders, null, 2));
  console.log(`\n${holders.length} current holder(s) -> ${path.relative(process.cwd(), out)}`);
  if (holders.length === 0) {
    console.log("NOTE: zero holders. Verify that is real before passing an empty array to initializeV3.");
  }
}

main().catch((e) => { console.error("\n" + (e.message ?? e)); process.exitCode = 1; });

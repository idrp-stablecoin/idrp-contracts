/**
 * Enumerate every current DEFAULT_ADMIN_ROLE holder on the Controller. Read-only.
 *
 *   npx hardhat run scripts/tron-list-default-admin-holders.ts --network tron   (or nile | tre)
 *
 * WHY THIS MATTERS
 *   initializeV3(_admin, _upgrader, _legacyDefaultAdminHolders) revokes exactly the
 *   addresses handed to it, then hands DEFAULT_ADMIN to a single ACDAR admin. Any legacy
 *   holder missing from that array KEEPS DEFAULT_ADMIN_ROLE after the upgrade — a hidden
 *   admin. The list must be complete, so run this on the day.
 *
 * HOW
 *   Every RoleGranted / RoleRevoked log for DEFAULT_ADMIN_ROLE is read with eth_getLogs
 *   (role and account are indexed: topics[1], topics[2]) over the proxy's whole history,
 *   and every candidate is confirmed with a live hasRole. On tron / nile TronGrid's event
 *   index narrows the block range first (it locates the blocks but cannot decode these
 *   events: the proxies have no ABI registered there). On the local TVM the whole chain
 *   is scanned. A read that cannot be completed is fatal, never a "no".
 */
import hre from "hardhat";
import { ethers } from "ethers";
import { tronNetwork, jsonRpc, base58Of, hexOf } from "./utils/tron-network";
import { DEFAULT_ADMIN_ROLE, hasRole } from "./utils/tron-steps";

const MAX_RANGE = 5000; // TronGrid's limit per eth_getLogs
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const net = await tronNetwork(hre);
  const proxy = net.controller;
  const proxyHex = hexOf(net, proxy);
  console.log(`network          ${net.name} — ${net.label}`);
  console.log(`controller proxy ${proxy}`);
  console.log(`role             DEFAULT_ADMIN_ROLE (0x00…00)\n`);

  const T_GRANT = ethers.id("RoleGranted(bytes32,address,address)");
  const T_REVOKE = ethers.id("RoleRevoked(bytes32,address,address)");
  const latest = Number(await jsonRpc(net.host, net.headers, "eth_blockNumber", []));

  let from = 0;
  let to = latest;
  if (net.name !== "tre") {
    const blocks: number[] = [];
    for (const ev of ["RoleGranted", "RoleRevoked"]) {
      let url = `${net.host}/v1/contracts/${proxy}/events?event_name=${ev}&limit=200&order_by=block_timestamp,asc`;
      for (let page = 0; page < 50 && url; page++) {
        let body: any = null;
        for (let a = 0; a < 5 && !body; a++) {
          try {
            const r = await fetch(url, { headers: net.headers }).then((x) => x.json());
            if (r && Array.isArray(r.data)) body = r;
          } catch { /* retry */ }
          if (!body) await sleep(1000 * (a + 1));
        }
        if (!body) throw new Error(`TronGrid event index failed for ${ev}`);
        for (const e of body.data) if (typeof e.block_number === "number") blocks.push(e.block_number);
        url = body.meta?.links?.next ?? "";
        await sleep(300);
      }
    }
    console.log(`indexed role events: ${blocks.length}`);
    if (!blocks.length) throw new Error(`no role events indexed for ${proxy}. Do NOT read that as "no holders" — verify by hand.`);
    from = Math.max(0, Math.min(...blocks) - 100);
    to = Math.min(latest, Math.max(...blocks) + 100);
  }
  console.log(`scanning blocks ${from}..${to}\n`);

  const logs: any[] = [];
  for (const topic0 of [T_GRANT, T_REVOKE]) {
    for (let lo = from; lo <= to; lo += MAX_RANGE) {
      const hi = Math.min(lo + MAX_RANGE - 1, to);
      const res = await jsonRpc(net.host, net.headers, "eth_getLogs", [{
        address: proxyHex, topics: [topic0, DEFAULT_ADMIN_ROLE],
        fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16),
      }]);
      if (!Array.isArray(res)) throw new Error(`eth_getLogs ${lo}..${hi} returned ${JSON.stringify(res)}`);
      logs.push(...res);
      if (net.name !== "tre") await sleep(250);
    }
  }
  const candidates = new Set<string>();
  for (const l of logs) if (l.topics?.[2]) candidates.add("0x" + l.topics[2].slice(-40).toLowerCase());
  console.log(`DEFAULT_ADMIN role logs: ${logs.length}; distinct accounts: ${candidates.size}`);
  if (!candidates.size) throw new Error(`no DEFAULT_ADMIN grants found in the scanned range. Verify by hand.`);

  const holders: string[] = [];
  for (const a of candidates) {
    const has = await hasRole(net, proxyHex, DEFAULT_ADMIN_ROLE, a);
    console.log(`  ${has ? "HOLDS " : "  --  "} ${base58Of(net, a)}  ${a}`);
    if (has) holders.push(a);
  }
  console.log(`\nCurrent DEFAULT_ADMIN_ROLE holders: ${holders.length}`);
  console.log(`Pass EXACTLY these to initializeV3 (CTRL_V3_LEGACY_DAR_HOLDERS):`);
  console.log(`  ${holders.map((h) => base58Of(net, h)).join(",")}`);
  console.log(`Anything left out keeps DEFAULT_ADMIN_ROLE after the upgrade.`);
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

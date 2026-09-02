/**
 * Tron MAINNET: enumerate every current DEFAULT_ADMIN_ROLE holder on the Controller.
 *
 *   npx hardhat run scripts/tron-list-default-admin-holders.ts --network tron
 *
 * Read-only.
 *
 * WHY THIS MATTERS
 *   `initializeV3(_admin, _upgrader, _legacyDefaultAdminHolders)` revokes exactly
 *   the addresses handed to it, then hands DEFAULT_ADMIN to a single ACDAR admin.
 *   Any legacy holder missing from that array KEEPS DEFAULT_ADMIN_ROLE after the
 *   upgrade — a hidden admin that survives the migration. The list must be complete.
 *
 *   scripts/list-default-admin-holders.ts does this for EVM chains via
 *   deployment/chain-<id>.json and ethers log queries; neither works on Tron.
 *   This walks TronGrid's event index instead and confirms every candidate with a
 *   live `hasRole` call, so revoked-then-not-regranted addresses drop out.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://api.trongrid.io";
const PROXY = "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX";
const DEFAULT_ADMIN_ROLE = "0x" + "0".repeat(64);

const ABI = [
  { inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    name: "hasRole", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TronGrid's event index knows WHICH transactions and blocks emitted an event,
 * but returns an empty `result` unless the contract's ABI is registered with them
 * — and ours is not. So use it only to locate the blocks, then read the raw topics
 * over that range with eth_getLogs and decode them here. Both `role` and `account`
 * are indexed, so they land in topics[1] and topics[2].
 */
async function eventBlocks(eventName: string): Promise<number[]> {
  const blocks: number[] = [];
  let url = `${HOST}/v1/contracts/${PROXY}/events?event_name=${eventName}&limit=200&order_by=block_timestamp,asc`;
  for (let page = 0; page < 50 && url; page++) {
    let body: any = null;
    for (let a = 0; a < 5 && !body; a++) {
      try {
        const r = await fetch(url).then((x) => x.json());
        if (r && Array.isArray(r.data)) body = r;
      } catch { /* retry */ }
      if (!body) await sleep(1000 * (a + 1));
    }
    if (!body) throw new Error(`TronGrid event index failed for ${eventName}`);
    for (const e of body.data) if (typeof e.block_number === "number") blocks.push(e.block_number);
    url = body.meta?.links?.next ?? "";
    await sleep(300);
  }
  return blocks;
}

async function rpc(method: string, params: unknown[]) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${HOST}/jsonrpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      }).then((x) => x.json());
      if (r.result !== undefined) return r.result;
      if (r.error) throw new Error(r.error.message);
    } catch (e: any) {
      if (a === 5) throw e;
      await sleep(900 * (a + 1));
    }
  }
}

const MAX_RANGE = 5000; // TronGrid hard limit on eth_getLogs

async function logsInRange(proxyHex: string, topic0: string, from: number, to: number) {
  const out: any[] = [];
  for (let lo = from; lo <= to; lo += MAX_RANGE) {
    const hi = Math.min(lo + MAX_RANGE - 1, to);
    const res = await rpc("eth_getLogs", [{
      address: proxyHex,
      topics: [topic0, DEFAULT_ADMIN_ROLE],   // role is indexed -> topics[1]
      fromBlock: "0x" + lo.toString(16),
      toBlock: "0x" + hi.toString(16),
    }]);
    if (Array.isArray(res)) out.push(...res);
    await sleep(250);
  }
  return out;
}

async function main() {
  if (hre.network.name !== "tron") throw new Error(`Tron MAINNET only (got ${hre.network.name})`);
  const tw = new TronWeb({ fullHost: HOST });

  console.log(`Controller proxy : ${PROXY}`);
  console.log(`Role             : DEFAULT_ADMIN_ROLE (0x00…00)\n`);

  const proxyHex = "0x" + tw.address.toHex(PROXY).slice(2);
  const { keccak256, toUtf8Bytes } = await import("ethers");
  const T_GRANT = keccak256(toUtf8Bytes("RoleGranted(bytes32,address,address)"));
  const T_REVOKE = keccak256(toUtf8Bytes("RoleRevoked(bytes32,address,address)"));

  const gBlocks = await eventBlocks("RoleGranted");
  const rBlocks = await eventBlocks("RoleRevoked");
  const all = [...gBlocks, ...rBlocks];
  console.log(`RoleGranted events indexed: ${gBlocks.length}   RoleRevoked: ${rBlocks.length}`);

  if (!all.length) {
    console.log(`\nNo role events indexed at all. Do NOT read that as "no holders" —`);
    console.log(`verify manually before upgrading.`);
    process.exit(1);
  }

  // Pad the window so nothing at the edges is missed.
  const from = Math.max(0, Math.min(...all) - 100);
  const to = Math.max(...all) + 100;
  console.log(`Scanning blocks ${from}..${to} (${to - from + 1}) for DEFAULT_ADMIN role events\n`);

  const grants = await logsInRange(proxyHex, T_GRANT, from, to);
  const revokes = await logsInRange(proxyHex, T_REVOKE, from, to);
  console.log(`DEFAULT_ADMIN RoleGranted logs: ${grants.length}   RoleRevoked logs: ${revokes.length}`);

  const candidates = new Set<string>();
  for (const l of [...grants, ...revokes]) {
    const acct = l.topics?.[2];               // account is indexed -> topics[2]
    if (acct) candidates.add("0x" + acct.slice(-40).toLowerCase());
  }
  console.log(`distinct DEFAULT_ADMIN candidates: ${candidates.size}\n`);

  if (!candidates.size) {
    console.log(`No DEFAULT_ADMIN grants found in the scanned range. Verify manually.`);
    process.exit(1);
  }

  // hasRole via raw eth_call. An earlier version used tronweb's contract wrapper
  // inside try/catch and left `has = false` when the call failed — so a rate-limited
  // read looked exactly like "does not hold the role", and the script emitted an
  // EMPTY holders array while the upgrader genuinely held DEFAULT_ADMIN. Never
  // default this to false: a lookup that cannot be completed is fatal, not a "no".
  const { AbiCoder } = await import("ethers");
  const HAS_ROLE_SELECTOR = keccak256(toUtf8Bytes("hasRole(bytes32,address)")).slice(0, 10);

  async function hasRole(account: string): Promise<boolean> {
    const data = HAS_ROLE_SELECTOR +
      new AbiCoder().encode(["bytes32", "address"], [DEFAULT_ADMIN_ROLE, account]).slice(2);
    const res = await rpc("eth_call", [{ to: proxyHex, data }, "latest"]);
    if (typeof res !== "string" || !/^0x[0-9a-f]*$/i.test(res)) {
      throw new Error(`hasRole(${account}) returned a non-result: ${JSON.stringify(res)}`);
    }
    const n = BigInt(res);
    if (n !== 0n && n !== 1n) throw new Error(`hasRole(${account}) returned ${res}`);
    return n === 1n;
  }

  const holders: string[] = [];
  for (const addr of candidates) {
    const has = await hasRole(addr);          // throws rather than guessing
    let b58 = "?";
    try { b58 = tw.address.fromHex("41" + addr.slice(2)); } catch { /* ignore */ }
    console.log(`  ${has ? "HOLDS " : "  --  "} ${addr}  ${b58}`);
    if (has) holders.push(addr);
    await sleep(400);
  }

  console.log(`\nCurrent DEFAULT_ADMIN_ROLE holders: ${holders.length}`);
  console.log(`\nPass EXACTLY these to initializeV3 as _legacyDefaultAdminHolders:`);
  console.log(JSON.stringify(holders, null, 2));
  console.log(`\nAnything omitted here keeps DEFAULT_ADMIN_ROLE after the upgrade.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

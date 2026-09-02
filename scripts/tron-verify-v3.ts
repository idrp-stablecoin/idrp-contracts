/**
 * Tron MAINNET: snapshot the Controller / Token state around the v3 upgrade.
 *
 *   TARGET=controller npx hardhat run scripts/tron-verify-v3.ts --network tron
 *   TARGET=token      npx hardhat run scripts/tron-verify-v3.ts --network tron
 *
 * Read-only. Run it BEFORE the upgrade to capture a baseline and AFTER to confirm.
 *
 * WHY A DEDICATED SCRIPT
 *   check-tron-roles.ts reads a deployment JSON and only covers the Token's
 *   MINTER/PAUSER/FREEZER/UPGRADER roles. It does not touch the Controller's quorum
 *   roles, defaultAdmin(), the pending schedule, or the TronUUPS proxy slot — which
 *   are the things that actually decide whether this upgrade went well.
 *
 * Everything is a raw eth_call and every failure throws. A read that cannot be
 * completed must never be reported as a `false`.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://api.trongrid.io";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_SLOTS = ["idrp.tron.uups.__self", "idrp.tron.uups.__proxy"];

const PROXIES: Record<string, { addr: string; label: string }> = {
  controller: { addr: "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX", label: "IDRPController" },
  token: { addr: "TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r", label: "IDRP token" },
};

// The four quorum signers granted at deployment. They must survive the upgrade
// with no re-grant; the local TVM rehearsal shows 4/4 do.
const QUORUM = {
  OFFICER_ROLE: "0xb490d3db1f0567c7a6f7e3468a35842392ed04b3",
  MANAGER_ROLE: "0xd3eeba4ff3da9818a8524c5f76f5935040f4952e",
  DIRECTOR_ROLE: "0x0b13ced0bdc13d3935adede2befce9b6cc7a2c9b",
  COMMISSIONER_ROLE: "0x894d0762b01166641d78987cc6257a3417b982e4",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A contract REVERT and a failed RPC look similar and must not be conflated: a
 * revert is a real answer ("this implementation has no such function"), a transport
 * failure is not an answer at all. Reverts come back as REVERTED; everything else
 * is retried and then thrown.
 */
const REVERTED = "0x";

async function rpc(method: string, params: unknown[]) {
  let last: any;
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${HOST}/jsonrpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      }).then((x) => x.json());
      if (r.result !== undefined) return r.result as string;
      if (r.error && /revert/i.test(String(r.error.message))) return REVERTED;
      last = r.error;
    } catch (e) { last = e; }
    await sleep(800 * (a + 1));
  }
  throw new Error(`${method} failed: ${JSON.stringify(last)}`);
}

const isRevert = (v: string) => !v || v === "0x";
const toAddr = (v: string) => "0x" + v.slice(-40);
const isZero = (v: string) => /^0x0*$/.test(v || "0x0");

async function main() {
  if (hre.network.name !== "tron") throw new Error(`Tron MAINNET only (got ${hre.network.name})`);
  const target = (process.env.TARGET ?? "").toLowerCase();
  if (!PROXIES[target]) throw new Error(`Set TARGET=controller or TARGET=token`);
  const { addr: proxyT, label } = PROXIES[target];

  const tw = new TronWeb({ fullHost: HOST });
  const { keccak256, toUtf8Bytes, AbiCoder } = await import("ethers");
  const proxyHex = "0x" + tw.address.toHex(proxyT).slice(2);
  const sel = (sig: string) => keccak256(toUtf8Bytes(sig)).slice(0, 10);
  const call = (data: string) => rpc("eth_call", [{ to: proxyHex, data }, "latest"]);

  console.log(`\n${"━".repeat(74)}\n${label}   ${proxyT}\n${"━".repeat(74)}`);

  const impl = toAddr(await rpc("eth_getStorageAt", [proxyHex, IMPL_SLOT, "latest"]));
  console.log(`  implementation          ${impl}  (${tw.address.fromHex("41" + impl.slice(2))})`);

  // --- plain address getters. Absent on v2 -> "0x" (revert), which is expected pre-upgrade.
  const getters = target === "controller"
    ? ["upgrader()", "idrpToken()", "defaultAdmin()", "scheduledImplementation()"]
    : ["upgrader()", "admin()", "controller()", "sanctionsList()", "scheduledImplementation()"];
  console.log(`\n  getters`);
  for (const g of getters) {
    const v = await call(sel(g));
    console.log(`    ${g.padEnd(28)} ${isRevert(v) ? "reverts — not present on this implementation" : toAddr(v)}`);
    await sleep(250);
  }

  // --- quorum roles (controller only)
  if (target === "controller") {
    console.log(`\n  quorum roles — must be true both before AND after, with no re-grant`);
    const hasRoleSel = sel("hasRole(bytes32,address)");
    let ok = 0;
    for (const [role, acct] of Object.entries(QUORUM)) {
      const data = hasRoleSel + new AbiCoder()
        .encode(["bytes32", "address"], [keccak256(toUtf8Bytes(role)), acct]).slice(2);
      const v = await call(data);
      if (isRevert(v)) throw new Error(`hasRole(${role}) reverted — cannot verify`);
      const has = BigInt(v) === 1n;
      if (has) ok++;
      console.log(`    ${role.padEnd(20)} ${acct}  ${has ? "✓" : "✗ MISSING"}`);
      await sleep(250);
    }
    console.log(`    -> ${ok}/4`);
    if (ok !== 4) throw new Error(`only ${ok}/4 quorum roles present`);
  }

  // --- the check that the proxy is still upgradeable
  console.log(`\n  upgradeability`);
  let slotsClean = true;
  for (const name of PROXY_SLOTS) {
    const v = await rpc("eth_getStorageAt", [proxyHex, keccak256(toUtf8Bytes(name)), "latest"]);
    const clean = isZero(v);
    if (!clean) slotsClean = false;
    console.log(`    ${name.padEnd(24)} ${clean ? "0x0 ✓" : "SET ✗ " + v}`);
    await sleep(250);
  }
  console.log(`    -> ${slotsClean
    ? "no storage-dependent proxy gate — the proxy can still be upgraded"
    : "A TRONUUPS SLOT IS SET — future upgrades will revert. Investigate immediately."}`);
  if (!slotsClean) process.exit(1);

  const sched = await call(sel("scheduledImplementation()"));
  if (!isRevert(sched)) {
    console.log(`\n  pending schedule        ${isZero(sched) ? "none ✓" : toAddr(sched) + "  <- still pending"}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

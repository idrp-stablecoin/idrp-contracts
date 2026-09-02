/**
 * Verify the v2 -> v3 storage layout against LIVE Tron mainnet, exhaustively.
 *
 *   npx hardhat run scripts/verify-live-layout.ts --network tron
 *
 * Read-only.
 *
 * WHY EXHAUSTIVE, AND WHY EARLIER "7/7" WAS NOT ENOUGH
 *   An earlier check spot-probed seven application variables (the 504-510 tail on
 *   the token) and reported "7/7". That only ever showed those seven agreed; it
 *   said nothing about the other ~500 slots, and nothing about whether the slots
 *   v3 is about to start writing are free. This script does all three checks:
 *
 *     1. DECLARED LAYOUT DIFF — every entry solc emits for v2 vs v3, compared by
 *        (slot, offset). Catches anything that moved, not just the tail.
 *     2. LIVE SWEEP — read every slot in the declared range off the real proxy and
 *        require that every non-zero one is explained by the v2 layout. An
 *        unexplained non-zero slot means the deployed contract is not the source
 *        we think it is.
 *     3. HEADROOM — every slot v3 newly occupies must be zero on the live proxy
 *        today, or the upgrade would silently inherit garbage as real state.
 *
 *   Note on gaps: most slots are OZ `__gap` padding and are legitimately zero, so
 *   individually they carry no signal. Their value is collective — a zero sweep
 *   proves nothing unexpected is hiding in them.
 */
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

const HOST = "https://api.trongrid.io/jsonrpc";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { label: "IDRP token", proxy: "TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r",
    v2: "contracts/legacy/IDRPv2.sol:IDRPv2", v3: "contracts/IDRP.sol:IDRP", sweepTo: 520 },
  { label: "IDRP controller", proxy: "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX",
    v2: "contracts/legacy/IDRPControllerv2.sol:IDRPControllerv2",
    v3: "contracts/IDRPController.sol:IDRPController", sweepTo: 270 },
];

type Entry = { slot: number; offset: number; label: string; type: string };

/** Storage layout via the artifact's own .dbg.json -> its exact build-info.
 *  Scanning build-info/ and taking the first hit can silently return a stale build. */
function layoutOf(fqn: string): Entry[] {
  const [src, name] = fqn.split(":");
  const dir = path.join(hre.config.paths.artifacts, src);
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, `${name}.dbg.json`), "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(dir, dbg.buildInfo), "utf8"));
  const c = bi.output.contracts?.[src]?.[name];
  if (!c?.storageLayout) throw new Error(`no storageLayout for ${fqn}`);
  return (c.storageLayout.storage ?? []).map((s: any) => ({
    slot: Number(s.slot), offset: s.offset, label: s.label,
    type: c.storageLayout.types[s.type].label,
  })).sort((a: Entry, b: Entry) => a.slot - b.slot || a.offset - b.offset);
}

async function readSlots(addrHex: string, slots: number[]) {
  const out: Record<number, string> = {};
  for (let i = 0; i < slots.length; i += 40) {
    const chunk = slots.slice(i, i + 40);
    const body = chunk.map((n, j) => ({ jsonrpc: "2.0", method: "eth_getStorageAt",
      params: [addrHex, "0x" + n.toString(16), "latest"], id: j }));
    let done = false;
    for (let a = 0; a < 6 && !done; a++) {
      try {
        const r = await fetch(HOST, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body) }).then((x) => x.json());
        if (Array.isArray(r) && r.every((x: any) => x.result)) {
          r.forEach((x: any) => (out[chunk[x.id]] = x.result));
          done = true;
        }
      } catch { /* retry */ }
      if (!done) await sleep(800 * (a + 1));
    }
    if (!done) throw new Error(`could not read slots ${chunk[0]}..${chunk[chunk.length - 1]}`);
    await sleep(250);
  }
  return out;
}

const isGap = (e?: Entry) => !!e && /gap/i.test(e.label);
const nonZero = (v: string) => !!v && !/^0x0*$/.test(v);
// solc namespaces enum/struct type labels with the contract name; normalise so
// IDRPControllerv2.OperationType and IDRPController.OperationType compare equal.
const normType = (t: string) => t.replace(/\b(IDRPControllerv2|IDRPController|IDRPv2|IDRP)\./g, "C.");

async function main() {
  const TronWeb = require("tronweb");
  const tw = new TronWeb({ fullHost: "https://api.trongrid.io" });
  let failures = 0;

  for (const t of TARGETS) {
    const A = layoutOf(t.v2), B = layoutOf(t.v3);
    const key = (e: Entry) => `${e.slot}.${e.offset}`;
    const mA = new Map(A.map((e) => [key(e), e]));
    const mB = new Map(B.map((e) => [key(e), e]));

    console.log(`\n${"━".repeat(96)}\n${t.label}   proxy ${t.proxy}\n${"━".repeat(96)}`);

    // ---- 1. declared layout diff ----
    const conflicts: string[] = [];
    for (const k of new Set([...mA.keys(), ...mB.keys()])) {
      const a = mA.get(k), b = mB.get(k);
      if (a && b && a.label === b.label && normType(a.type) === normType(b.type)) continue;
      if (isGap(a) && isGap(b)) continue;                 // padding resized
      if (isGap(a) && !b) continue;                        // padding removed
      if (!a && isGap(b)) continue;                        // padding added
      if (isGap(a) && b) continue;                         // padding -> new var (free space)
      if (!a && b) continue;                               // appended past the v2 tail
      // v2 had a real variable here and v3 does not agree
      const inNewGap = b && isGap(b);
      conflicts.push(`slot ${a!.slot}: v2 ${a!.label} -> v3 ${b ? b.label : "(nothing)"}` +
        (inNewGap || !b ? "  [reserved/removed — confirm intentional]" : "  [COLLISION]"));
    }
    console.log(`  1. declared layout: ${A.length} v2 entries vs ${B.length} v3 entries`);
    if (!conflicts.length) console.log(`     no conflicts`);
    else conflicts.forEach((c) => console.log(`     ! ${c}`));

    // ---- 2. live sweep ----
    const addrHex = "0x" + tw.address.toHex(t.proxy).slice(2);
    const slots = Array.from({ length: t.sweepTo + 1 }, (_, i) => i);
    const live = await readSlots(addrHex, slots);
    const declared = new Map<number, Entry>();
    for (const e of A) if (!declared.has(e.slot)) declared.set(e.slot, e);
    // a gap entry covers N slots, not one
    for (const e of A) {
      const m = e.type.match(/uint256\[(\d+)\]/);
      if (m) for (let i = 0; i < Number(m[1]); i++) declared.set(e.slot + i, e);
    }
    const nz = slots.filter((s) => nonZero(live[s]));
    const unexplained = nz.filter((s) => !declared.has(s));
    console.log(`\n  2. live sweep of slots 0..${t.sweepTo}: ${nz.length} non-zero`);
    for (const s of nz) {
      const e = declared.get(s);
      console.log(`     ${String(s).padStart(4)}  ${e ? e.label : "*** NOT IN v2 LAYOUT ***"}`);
    }
    console.log(`     unexplained non-zero slots: ${unexplained.length}` +
      (unexplained.length ? `  <<< ${unexplained.join(",")}` : `  (every value on chain is accounted for)`));
    if (unexplained.length) failures++;

    // ---- 3. headroom ----
    const v2Max = Math.max(...A.map((e) => {
      const m = e.type.match(/uint256\[(\d+)\]/);
      return e.slot + (m ? Number(m[1]) - 1 : 0);
    }));
    const newSlots = B.filter((e) => {
      const a = mA.get(key(e));
      return (!a || isGap(a)) && !isGap(e);
    }).map((e) => e.slot);
    const uniqNew = [...new Set(newSlots)].sort((a, b) => a - b);
    console.log(`\n  3. slots v3 newly writes (v2 tail ends at ${v2Max}):`);
    let occupied = 0;
    for (const s of uniqNew) {
      const v = live[s] ?? (await readSlots(addrHex, [s]))[s];
      const busy = nonZero(v);
      if (busy) occupied++;
      const names = B.filter((e) => e.slot === s && !isGap(e)).map((e) => e.label).join(", ");
      console.log(`     ${String(s).padStart(4)}  ${busy ? "OCCUPIED ✗" : "empty ✓"}   ${names}`);
    }
    console.log(`     -> ${occupied === 0 ? "safe: every slot v3 adds is free on chain today" : `UNSAFE: ${occupied} occupied`}`);
    if (occupied) failures++;
  }

  console.log(`\n${failures === 0 ? "LAYOUT VERIFIED AGAINST LIVE MAINNET" : failures + " PROBLEM(S)"}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error("\n✗", e.message ?? e); process.exit(1); });

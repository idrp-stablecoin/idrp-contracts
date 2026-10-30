/**
 * The upgrade steps the tron-* scripts run: cancel, schedule, execute. Every step reads
 * the proxy, simulates the exact call from the signer (a revert stops it before anything
 * is spent), and sends only through the funding gate (a dry run unless EXECUTE=1).
 */
import { ethers } from "ethers";
import type { TronNet } from "./tron-network";
import { base58Of, hexOf, recordUpgradeEvent } from "./tron-network";
import { decodeRevert, ethCall, gatedSend, getStorage, simulate } from "./tron-preflight";
import { checkImplementation, IMPL_SLOT, KINDS, type Kind } from "./tron-impl";

export const PROXY_SLOT_NAMES = ["idrp.tron.uups.__self", "idrp.tron.uups.__proxy"];
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = /^(0x)?0*$/;

const ERRORS = new ethers.Interface([
  "error NotUpgrader()",
  "error NotAdmin()",
  "error TronUUPSUnauthorizedCallContext()",
]);

export const proxyOf = (net: TronNet, kind: Kind) => (kind === "controller" ? net.controller : net.token);

const sel = (sig: string) => ethers.id(sig).slice(0, 10);

async function readAddress(net: TronNet, toHex: string, sig: string): Promise<string | null> {
  const v = await ethCall(net, toHex, sel(sig));
  return v && v !== "0x" ? "0x" + v.slice(-40).toLowerCase() : null;
}

async function readUint(net: TronNet, toHex: string, sig: string): Promise<bigint | null> {
  const v = await ethCall(net, toHex, sel(sig));
  return v && v !== "0x" ? BigInt(v) : null;
}

export type ProxyState = {
  proxy: string;
  proxyHex: string;
  implementation: string;
  upgrader: string;
  scheduled: string | null;
  scheduledAt: bigint;
  delay: bigint;
};

export async function proxyState(net: TronNet, kind: Kind): Promise<ProxyState> {
  const proxy = proxyOf(net, kind);
  const proxyHex = hexOf(net, proxy);
  const impl = "0x" + (await getStorage(net, proxyHex, IMPL_SLOT)).slice(-40).toLowerCase();
  const upgrader = await readAddress(net, proxyHex, "upgrader()");
  if (!upgrader) throw new Error(`${proxy}: upgrader() did not answer`);
  const scheduled = await readAddress(net, proxyHex, "scheduledImplementation()");
  const scheduledAt = (await readUint(net, proxyHex, "upgradeScheduledAt()")) ?? 0n;
  const delay = await readUint(net, proxyHex, "UPGRADE_DELAY()");
  if (delay === null) throw new Error(`${proxy}: UPGRADE_DELAY() did not answer`);
  return {
    proxy, proxyHex, implementation: impl, upgrader,
    scheduled: scheduled && !ZERO.test(scheduled) ? scheduled : null,
    scheduledAt, delay,
  };
}

export function printHeader(net: TronNet, title: string) {
  console.log(`${title}`);
  console.log(`  network       ${net.name} — ${net.label} (chain id ${net.chainId})`);
  console.log(`  signer        ${net.signer}`);
  console.log(`  record        ${net.recordPath}`);
}

export function printState(net: TronNet, kind: Kind, s: ProxyState) {
  const t = (h: string) => `${base58Of(net, h)} (${h})`;
  console.log(`\n  ${KINDS[kind].name} proxy  ${s.proxy}`);
  console.log(`    implementation       ${t(s.implementation)}`);
  console.log(`    upgrader()           ${t(s.upgrader)}${s.upgrader === net.signerHex ? "  = signer" : ""}`);
  console.log(`    UPGRADE_DELAY()      ${s.delay} s`);
  if (s.scheduled) {
    const ready = Number(s.scheduledAt + s.delay);
    console.log(`    pending schedule     ${t(s.scheduled)}`);
    console.log(`    executable after     ${new Date(ready * 1000).toISOString()}`);
  } else {
    console.log(`    pending schedule     none`);
  }
}

/** The proxy's current delay governs the wait; it must be this network's. */
function requireNetworkDelay(net: TronNet, s: ProxyState) {
  if (s.delay !== BigInt(net.delaySeconds)) {
    throw new Error(`${s.proxy}: UPGRADE_DELAY() is ${s.delay} s, ${net.name} runs ${net.delaySeconds} s. Wrong proxy or wrong network — stopping.`);
  }
}

async function simulateFromSigner(net: TronNet, proxy: string, signature: string, args: unknown[], iface?: ethers.Interface) {
  const frag = ethers.FunctionFragment.from(`function ${signature}`);
  const parameter = ethers.AbiCoder.defaultAbiCoder().encode(frag.inputs, args).slice(2);
  const sim = await simulate(net, { owner: net.signer, contract: proxy, selector: frag.format("sighash"), parameter }, iface ?? ERRORS);
  return { sim, selector: frag.format("sighash"), parameter };
}

function buildCall(net: TronNet, proxy: string, selector: string, parameter: string) {
  return async (feeLimit: number) => {
    const built = await net.tw.transactionBuilder.triggerSmartContract(
      net.tw.address.toHex(proxy), selector, { feeLimit, callValue: 0, rawParameter: parameter }, [], net.tw.address.toHex(net.signer),
    );
    if (!built?.result?.result || !built.transaction) throw new Error(`could not build ${selector}: ${JSON.stringify(built?.result ?? built)}`);
    return built.transaction;
  };
}

/** Local TVM mines only when a transaction arrives, so block time goes stale. Send one so time-dependent simulations see now. */
async function tickTre(net: TronNet) {
  if (net.name !== "tre") return;
  const sink = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"; // the black-hole address
  const tx = await net.tw.transactionBuilder.sendTrx(sink, 1, net.signer);
  await net.tw.trx.sendRawTransaction(await net.tw.trx.sign(tx));
  await new Promise((r) => setTimeout(r, 4000));
}

// ───────────────────────────────── cancel ─────────────────────────────────

export async function cancelStep(net: TronNet, kind: Kind) {
  const s = await proxyState(net, kind);
  printState(net, kind, s);
  if (!s.scheduled) {
    console.log(`\n  nothing to cancel.`);
    return;
  }
  const { sim, selector, parameter } = await simulateFromSigner(net, s.proxy, "cancelUpgrade()", []);
  if (!sim.ok) {
    throw new Error(`cancelUpgrade() from ${net.signer} would revert: ${sim.reason}. The signer must be the upgrader. If that is a multisig, propose cancelUpgrade() through it instead.`);
  }
  const info = await gatedSend(net, { label: `${KINDS[kind].name}.cancelUpgrade() — drops ${base58Of(net, s.scheduled)}`, energy: sim.energy, build: buildCall(net, s.proxy, selector, parameter), iface: ERRORS });
  if (!info) return;
  const after = await proxyState(net, kind);
  if (after.scheduled) throw new Error(`scheduledImplementation is STILL ${after.scheduled} — investigate before continuing`);
  console.log(`  ✓ cleared: scheduledImplementation is 0x0`);
  recordUpgradeEvent(net, { step: "cancel", contract: KINDS[kind].name, cancelled: base58Of(net, s.scheduled), tx: info.id });
}

// ──────────────────────────────── schedule ────────────────────────────────

export async function scheduleStep(net: TronNet, kind: Kind, implInput: string | undefined) {
  if (!implInput) throw new Error(`Set IMPL=<the ${KINDS[kind].name} v3 implementation> (base58 T… or 0x…), as printed by the deploy step`);
  const implHex = hexOf(net, implInput.trim());
  const impl = base58Of(net, implHex);
  const s = await proxyState(net, kind);
  printState(net, kind, s);
  requireNetworkDelay(net, s);

  console.log(`\n  candidate ${impl}`);
  for (const l of await checkImplementation(net, impl, kind)) console.log(`    ${l}`);
  const deployed = (net.record.upgrades ?? []).find((u: any) => u.step === "deploy" && u.implementation === impl);
  console.log(deployed
    ? `    recorded        deployed ${deployed.at} from ${String(deployed.sourceCommit).slice(0, 7)}, build ${deployed.build}`
    : `    recorded        NOT in ${net.recordPath} — it was not deployed from this checkout. The on-chain checks above still apply; verify its build on the explorer before executing.`);

  if (s.implementation === implHex) throw new Error(`${impl} is already the live implementation`);
  if (s.scheduled) {
    if (s.scheduled === implHex) throw new Error(`${impl} is already scheduled (since ${new Date(Number(s.scheduledAt) * 1000).toISOString()})`);
    if (process.env.REPLACE_PENDING !== "1") {
      throw new Error(`A different implementation is pending: ${base58Of(net, s.scheduled)}.\n  Cancel it first (preferred — leaves an auditable 0x0):\n    TARGET=${kind} npx hardhat run scripts/tron-cancel-upgrade.ts --network ${net.name}\n  or replace it in one call with REPLACE_PENDING=1 (the delay restarts).`);
    }
    console.log(`  ⚠ REPLACE_PENDING=1: this overwrites ${base58Of(net, s.scheduled)} and restarts the delay`);
  }

  const { sim, selector, parameter } = await simulateFromSigner(net, s.proxy, "scheduleUpgrade(address)", [implHex]);
  if (!sim.ok) throw new Error(`scheduleUpgrade from ${net.signer} would revert: ${sim.reason}. The signer must be the upgrader.`);
  const info = await gatedSend(net, { label: `${KINDS[kind].name}.scheduleUpgrade(${impl})`, energy: sim.energy, build: buildCall(net, s.proxy, selector, parameter), iface: ERRORS });
  if (!info) return;

  const after = await proxyState(net, kind);
  if (after.scheduled !== implHex) throw new Error(`scheduledImplementation reads ${after.scheduled}, expected ${implHex}`);
  const ready = Number(after.scheduledAt + after.delay);
  console.log(`  ✓ scheduled ${impl}`);
  console.log(`    executable after ${new Date(ready * 1000).toISOString()} (${after.delay} s from the block)`);
  recordUpgradeEvent(net, { step: "schedule", contract: KINDS[kind].name, implementation: impl, executableAfter: new Date(ready * 1000).toISOString(), tx: info.id });
}

// ──────────────────────────────── execute ─────────────────────────────────

export type InitArgs =
  | { kind: "controller"; admin: string; upgrader: string; legacyDefaultAdmins: string[] }
  | { kind: "token"; admin: string; controller: string; upgrader: string };

const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

async function hasRole(net: TronNet, proxyHex: string, role: string, account: string): Promise<boolean> {
  const data = sel("hasRole(bytes32,address)") + ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address"], [role, account]).slice(2);
  const v = await ethCall(net, proxyHex, data);
  if (v === null || v === "0x") throw new Error(`hasRole(${role.slice(0, 10)}…, ${account}) did not answer`);
  const b = BigInt(v);
  if (b !== 0n && b !== 1n) throw new Error(`hasRole returned ${v}`);
  return b === 1n;
}

/** Quorum signers that must hold their roles before and after, with no re-grant. */
export function quorumSigners(net: TronNet): Array<{ role: string; addr: string }> {
  if (Array.isArray(net.record.quorumSigners)) return net.record.quorumSigners;
  if (net.isMainnet) {
    // Measured on the mainnet controller (hasRole) — see tron-verify-v3.ts.
    return [
      { role: "OFFICER_ROLE", addr: "0xb490d3db1f0567c7a6f7e3468a35842392ed04b3" },
      { role: "MANAGER_ROLE", addr: "0xd3eeba4ff3da9818a8524c5f76f5935040f4952e" },
      { role: "DIRECTOR_ROLE", addr: "0x0b13ced0bdc13d3935adede2befce9b6cc7a2c9b" },
      { role: "COMMISSIONER_ROLE", addr: "0x894d0762b01166641d78987cc6257a3417b982e4" },
    ];
  }
  throw new Error(`${net.recordPath} lists no quorumSigners`);
}

export async function quorumRolesHeld(net: TronNet): Promise<{ held: number; total: number; lines: string[] }> {
  const ctrlHex = hexOf(net, net.controller);
  const lines: string[] = [];
  let held = 0;
  const signers = quorumSigners(net);
  for (const { role, addr } of signers) {
    const ok = await hasRole(net, ctrlHex, ethers.id(role), hexOf(net, addr));
    if (ok) held++;
    lines.push(`${role.padEnd(18)} ${base58Of(net, hexOf(net, addr))}  ${ok ? "✓" : "✗ MISSING"}`);
  }
  return { held, total: signers.length, lines };
}

/** upgradeTo(dead) from the upgrader must stop at the timelock check: the UUPS proxy gate still passes. */
export async function upgradeGateHealthy(net: TronNet, kind: Kind): Promise<string> {
  const s = await proxyState(net, kind);
  const r = await simulate(net, {
    owner: base58Of(net, s.upgrader),
    contract: s.proxy,
    selector: "upgradeTo(address)",
    parameter: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [DEAD]).slice(2),
  }, ERRORS);
  if (r.ok) throw new Error(`upgradeTo(dead) did NOT revert on ${s.proxy} — the timelock is not guarding it`);
  if (/active proxy|delegatecall/i.test(r.reason) || r.result.startsWith("beb6ee1f") || r.reason.startsWith("TronUUPSUnauthorizedCallContext")) {
    throw new Error(`${s.proxy} is FROZEN: the UUPS proxy gate rejects upgrades (${r.reason})`);
  }
  if (!/Upgrade not scheduled|Timelock not expired/.test(r.reason)) throw new Error(`${s.proxy}: unexpected upgrade-path revert "${r.reason}" — check by hand`);
  return r.reason;
}

export async function executeStep(net: TronNet, args: InitArgs) {
  const kind = args.kind;
  const s = await proxyState(net, kind);
  printState(net, kind, s);
  requireNetworkDelay(net, s);
  if (!s.scheduled) throw new Error("nothing is scheduled");
  const impl = base58Of(net, s.scheduled);
  if (process.env.IMPL && hexOf(net, process.env.IMPL.trim()) !== s.scheduled) {
    throw new Error(`IMPL=${process.env.IMPL} but the proxy has ${impl} scheduled`);
  }
  console.log(`\n  scheduled ${impl}`);
  for (const l of await checkImplementation(net, impl, kind)) console.log(`    ${l}`);

  const v3 = new ethers.Interface([`function ${KINDS[kind].initializeV3}`]);
  let initData: string;
  console.log(`\n  initializeV3`);
  if (args.kind === "controller") {
    if (!args.legacyDefaultAdmins.length) throw new Error("the legacy DEFAULT_ADMIN_ROLE holder list is empty");
    for (const h of args.legacyDefaultAdmins) {
      if (!(await hasRole(net, s.proxyHex, DEFAULT_ADMIN_ROLE, h))) {
        throw new Error(`${base58Of(net, h)} is in the legacy list but does NOT hold DEFAULT_ADMIN_ROLE — a typo or a stale list. Re-run tron-list-default-admin-holders.ts.`);
      }
    }
    console.log(`    _admin                     ${base58Of(net, args.admin)}`);
    console.log(`    _upgrader                  ${base58Of(net, args.upgrader)}`);
    console.log(`    _legacyDefaultAdminHolders ${args.legacyDefaultAdmins.map((h) => base58Of(net, h)).join(", ")} (each holds the role ✓)`);
    initData = v3.encodeFunctionData("initializeV3", [args.admin, args.upgrader, args.legacyDefaultAdmins]);
  } else {
    if (args.controller !== hexOf(net, net.controller)) {
      console.log(`    ⚠ _controller differs from the record's controller ${net.controller}`);
    }
    console.log(`    _admin       ${base58Of(net, args.admin)}`);
    console.log(`    _controller  ${base58Of(net, args.controller)}`);
    console.log(`    _upgrader    ${base58Of(net, args.upgrader)}`);
    initData = v3.encodeFunctionData("initializeV3", [args.admin, args.controller, args.upgrader]);
  }

  await tickTre(net);
  const implIface = new ethers.Interface([...ERRORS.fragments, ...v3.fragments]);
  const { sim, selector, parameter } = await simulateFromSigner(net, s.proxy, "upgradeToAndCall(address,bytes)", [s.scheduled, initData], implIface);
  if (!sim.ok) {
    throw new Error(`upgradeToAndCall(${impl}, initializeV3(…)) would revert: ${sim.reason}. Nothing was sent; the proxy is untouched.`);
  }
  console.log(`\n  simulated the atomic upgradeToAndCall(${impl}, initializeV3(…)): succeeds ✓`);
  const info = await gatedSend(net, {
    label: `${KINDS[kind].name}.upgradeToAndCall(${impl}, initializeV3(…)) — atomic`,
    energy: sim.energy,
    build: buildCall(net, s.proxy, selector, parameter),
    iface: implIface,
  });
  if (!info) return;

  const after = await proxyState(net, kind);
  const checks: Array<[string, boolean]> = [
    [`implementation is ${impl}`, after.implementation === s.scheduled],
    ["nothing pending", after.scheduled === null],
  ];
  if (args.kind === "controller") {
    checks.push([`defaultAdmin() = ${base58Of(net, args.admin)}`, (await readAddress(net, s.proxyHex, "defaultAdmin()")) === args.admin]);
    checks.push([`upgrader() = ${base58Of(net, args.upgrader)}`, after.upgrader === args.upgrader]);
    for (const h of args.legacyDefaultAdmins) {
      if (h === args.admin) continue;
      checks.push([`legacy ${base58Of(net, h)} no longer holds DEFAULT_ADMIN_ROLE`, !(await hasRole(net, s.proxyHex, DEFAULT_ADMIN_ROLE, h))]);
    }
    checks.push([`new admin holds DEFAULT_ADMIN_ROLE`, await hasRole(net, s.proxyHex, DEFAULT_ADMIN_ROLE, args.admin)]);
    const q = await quorumRolesHeld(net);
    checks.push([`quorum roles held without a re-grant: ${q.held}/${q.total}`, q.held === q.total]);
  } else {
    checks.push([`admin() = ${base58Of(net, args.admin)}`, (await readAddress(net, s.proxyHex, "admin()")) === args.admin]);
    checks.push([`controller() = ${base58Of(net, args.controller)}`, (await readAddress(net, s.proxyHex, "controller()")) === args.controller]);
    checks.push([`upgrader() = ${base58Of(net, args.upgrader)}`, after.upgrader === args.upgrader]);
  }
  for (const name of PROXY_SLOT_NAMES) {
    checks.push([`${name} is 0x0`, ZERO.test(await getStorage(net, s.proxyHex, ethers.id(name)))]);
  }
  try {
    checks.push([`upgrade gate still passes ("${await upgradeGateHealthy(net, kind)}")`, true]);
  } catch (e: any) {
    checks.push([`upgrade gate: ${e.message}`, false]);
  }
  let bad = 0;
  for (const [label, ok] of checks) {
    if (!ok) bad++;
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
  }
  recordUpgradeEvent(net, { step: "execute", contract: KINDS[kind].name, implementation: impl, tx: info.id, checksFailed: bad });
  if (bad) throw new Error(`${bad} post-upgrade check(s) failed — investigate before anything else`);
}

export { DEFAULT_ADMIN_ROLE, hasRole, readAddress, readUint, decodeRevert };

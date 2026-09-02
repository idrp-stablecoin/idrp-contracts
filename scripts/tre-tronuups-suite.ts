/**
 * TronUUPSUpgradeable on the REAL Controller and Token, on a local TVM.
 *
 *   docker run -d --name idrp-tre -p 9090:9090 tronbox/tre
 *   npx hardhat run scripts/tre-tronuups-suite.ts --network tre
 *
 * WHY THIS EXISTS
 *   The freeze that killed the Nile Controller had only ever been reproduced with
 *   StorageSlotUUPSMock — a 30-line fixture. That proves the base misbehaves; it
 *   does not prove our actual contracts inherit the misbehaviour. This runs both
 *   cases against the real IDRP and IDRPController sources with only the UUPS base
 *   swapped, so the conclusion is about the contracts we ship.
 *
 * TWO CASES PER CONTRACT
 *   B1  fresh proxy, initialised BY the TronUUPS implementation
 *       -> initialize() calls __UUPSUpgradeable_init(), the slot is written,
 *          upgrades keep working. This is the case the base was validated for.
 *   B2  pre-existing v2 proxy (stock OZ 4), upgraded INTO the TronUUPS impl
 *       -> the mainnet-realistic path: only initializeV3 runs, and initializeV3
 *          does NOT call __UUPSUpgradeable_init(). The slot stays zero and every
 *          later upgrade reverts TronUUPSUnauthorizedCallContext. Frozen.
 *
 *   B2 is the shape both Tron mainnet proxies are in, which is why the shipped
 *   build uses TronGaplessUUPSUpgradeable (bytecode immutable) instead.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "http://127.0.0.1:9090";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_SLOT_NAME = "idrp.tron.uups.__proxy";

let tw: any, me: string, meHex: string;
const results: [string, boolean, string][] = [];
const record = (name: string, pass: boolean, detail = "") => {
  results.push([name, pass, detail]);
  console.log(`   ${pass ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
};

async function deploy(name: string, params: any[], label: string) {
  const a = await hre.artifacts.readArtifact(name);
  const tx = await tw.transactionBuilder.createSmartContract(
    { abi: { entrys: a.abi }, bytecode: a.bytecode.replace(/^0x/, ""), feeLimit: 1_000_000_000,
      callValue: 0, userFeePercentage: 100, originEnergyLimit: 10_000_000,
      parameters: params, name: name.split(":").pop() },
    tw.address.toHex(me));
  const res = await tw.trx.sendRawTransaction(await tw.trx.sign(tx));
  if (!res.result) throw new Error(`${label} deploy failed: ${JSON.stringify(res)}`);
  await new Promise(r => setTimeout(r, 3000));
  const addr = tw.address.fromHex(tx.contract_address);
  console.log(`     ${label}: ${addr}`);
  return addr;
}

async function storage(proxyT: string, slot: string) {
  const r: any = await fetch(`${HOST}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getStorageAt",
      params: ["0x" + tw.address.toHex(proxyT).slice(2), slot, "latest"], id: 1 }),
  }).then(x => x.json());
  return r.result as string;
}
const asAddr = (h: string) => "0x" + (h || "").slice(-40);
const isEmpty = (h: string) => /^0x0*$/.test(h || "0x0");
const hexOf = (t: string) => "0x" + tw.address.toHex(t).slice(2);

/** One contract, both cases. */
async function run(opts: {
  title: string;
  v2: string; v3slot: string;          // fixture contract names
  v2InitSig: string; v2InitArgs: any[]; // initializer for the v2 proxy
  v3InitSig: string; v3InitArgs: any[]; // initializeV3, run during the B2 upgrade
}) {
  const { ethers } = hre;
  console.log(`\n${"─".repeat(78)}\n${opts.title}\n${"─".repeat(78)}`);

  const proxySlotKey = ethers.keccak256(ethers.toUtf8Bytes(PROXY_SLOT_NAME));

  // ---------------- B1: fresh proxy initialised BY the TronUUPS impl ----------------
  console.log(`\n  B1 — fresh proxy initialised BY the TronUUPS implementation`);
  const implA = await deploy(opts.v3slot, [], "TronUUPS impl");
  const implB = await deploy(opts.v3slot, [], "TronUUPS impl (upgrade target)");
  const initFresh = new ethers.Interface([`function ${opts.v2InitSig}`])
    .encodeFunctionData(opts.v2InitSig.split("(")[0], opts.v2InitArgs);
  const fresh = await deploy("ERC1967Proxy", [tw.address.toHex(implA), initFresh], "fresh proxy");

  const wrote = await storage(fresh, proxySlotKey);
  record(`${opts.title} B1: initialize() wrote the proxy slot`,
    asAddr(wrote).toLowerCase() === hexOf(fresh).toLowerCase(), asAddr(wrote));

  const art = await hre.artifacts.readArtifact(opts.v3slot);
  const c1 = await tw.contract(art.abi, fresh);
  const delay = Number(await c1.UPGRADE_DELAY().call());
  let b1ok = false;
  try {
    await c1.scheduleUpgrade(implB).send({ feeLimit: 500_000_000, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, delay * 1000 + 5000));
    await c1.upgradeTo(implB).send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, 3000));
    b1ok = asAddr(await storage(fresh, IMPL_SLOT)).toLowerCase() === hexOf(implB).toLowerCase();
  } catch { b1ok = false; }
  record(`${opts.title} B1: fresh TronUUPS proxy CAN still upgrade`, b1ok,
    "the base works for the case it was validated for");

  // -------- B2: pre-existing stock-OZ4 proxy upgraded INTO the TronUUPS impl --------
  console.log(`\n  B2 — pre-existing v2 proxy (stock OZ 4) upgraded INTO the TronUUPS impl`);
  const v2impl = await deploy(opts.v2, [], "v2 impl (stock OZ 4)");
  const initV2 = new ethers.Interface([`function ${opts.v2InitSig}`])
    .encodeFunctionData(opts.v2InitSig.split("(")[0], opts.v2InitArgs);
  const pre = await deploy("ERC1967Proxy", [tw.address.toHex(v2impl), initV2], "pre-existing proxy");
  // Implementations are stateless, so B1's two are reused as B2's targets. TRE
  // accounts have limited bandwidth and each deploy costs some.
  const implC = implB;
  const implD = implA;

  const v2art = await hre.artifacts.readArtifact(opts.v2);
  const p2 = await tw.contract(v2art.abi, pre);
  const initV3 = new ethers.Interface([`function ${opts.v3InitSig}`])
    .encodeFunctionData(opts.v3InitSig.split("(")[0], opts.v3InitArgs);
  const d2 = Number(await p2.UPGRADE_DELAY().call());
  await p2.scheduleUpgrade(implC).send({ feeLimit: 500_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, d2 * 1000 + 5000));
  await p2.upgradeToAndCall(implC, initV3).send({ feeLimit: 1_000_000_000, callValue: 0, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, 4000));
  record(`${opts.title} B2: atomic upgrade INTO the TronUUPS impl succeeds`,
    asAddr(await storage(pre, IMPL_SLOT)).toLowerCase() === hexOf(implC).toLowerCase(),
    "the old impl performs it and never consults the slot");
  record(`${opts.title} B2: proxy slot still EMPTY afterwards`,
    isEmpty(await storage(pre, proxySlotKey)),
    "initializeV3 does not call __UUPSUpgradeable_init");

  const stuck = await tw.contract(art.abi, pre);
  let frozen = false;
  try {
    await stuck.scheduleUpgrade(implD).send({ feeLimit: 500_000_000, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, d2 * 1000 + 5000));
    await stuck.upgradeTo(implD).send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, 3000));
    frozen = asAddr(await storage(pre, IMPL_SLOT)).toLowerCase() !== hexOf(implD).toLowerCase();
  } catch { frozen = true; }
  record(`${opts.title} B2: the NEXT upgrade is BLOCKED — proxy frozen`, frozen,
    "TronUUPSUnauthorizedCallContext — this is what killed the Nile Controller");
}

async function main() {
  const accts: any = await fetch(`${HOST}/admin/accounts-json`).then(r => r.json());
  tw = new TronWeb({ fullHost: HOST, privateKey: accts.privateKeys[0] });
  me = tw.address.fromPrivateKey(accts.privateKeys[0]);
  meHex = "0x" + tw.address.toHex(me).slice(2);
  console.log(`local TVM: ${HOST}\nsigner   : ${me}`);

  await run({
    title: "TOKEN",
    v2: "IDRPv2Tvm", v3slot: "IDRPTronUups",
    v2InitSig: "initialize(address)", v2InitArgs: [meHex],
    v3InitSig: "initializeV3(address,address,address)", v3InitArgs: [meHex, meHex, meHex],
  });

  await run({
    title: "CONTROLLER",
    v2: "IDRPControllerv2Tvm", v3slot: "IDRPControllerTronUups",
    v2InitSig: "initialize(address,address)", v2InitArgs: [meHex, meHex],
    v3InitSig: "initializeV3(address,address,address[])", v3InitArgs: [meHex, meHex, []],
  });

  console.log(`\n\n=== SUMMARY ===`);
  results.forEach(([n, p, d]) => console.log(`  ${p ? "✓" : "✗"} ${n}${d ? "  (" + d + ")" : ""}`));
  const failed = results.filter(([, p]) => !p);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { failed.forEach(([n]) => console.log("   - " + n)); process.exit(1); }
}

main().then(() => process.exit(0)).catch(e => { console.error("\n✗", e.message || JSON.stringify(e)); process.exit(1); });

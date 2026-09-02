/**
 * Full TVM suite. Everything runs on a local Tron node, so it is free and repeatable.
 *
 *   docker run -d --name idrp-tre -p 9090:9090 tronbox/tre
 *   npx hardhat run scripts/tre-suite.ts --network tre
 *
 * PART A — token upgrade, rehearsed from mainnet's real starting state
 * PART B — TronUUPSUpgradeable on TVM: does the storage-slot workaround behave as the
 *          in-house variant assumed, and does it freeze a proxy that never ran its
 *          initializer?
 *
 * Part B matters because that variant was written FOR Tron and only ever exercised on
 * Tron. Reasoning about it on the EVM would not settle anything.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "http://127.0.0.1:9090";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_SLOT_NAMES = ["idrp.tron.uups.__self", "idrp.tron.uups.__proxy"];

let tw: any, me: string, meHex: string;
const ok = (b: boolean) => (b ? "✓" : "✗");
const results: [string, boolean, string][] = [];
const record = (name: string, pass: boolean, detail = "") => {
  results.push([name, pass, detail]);
  console.log(`   ${ok(pass)} ${name}${detail ? "  — " + detail : ""}`);
};

async function deploy(name: string, params: any[], label: string) {
  const a = await hre.artifacts.readArtifact(name);
  const tx = await tw.transactionBuilder.createSmartContract(
    { abi: { entrys: a.abi }, bytecode: a.bytecode.replace(/^0x/, ""), feeLimit: 1_000_000_000,
      callValue: 0, userFeePercentage: 100, originEnergyLimit: 10_000_000, parameters: params, name },
    tw.address.toHex(me));
  const res = await tw.trx.sendRawTransaction(await tw.trx.sign(tx));
  if (!res.result) throw new Error(`${label} deploy failed: ${JSON.stringify(res)}`);
  await new Promise(r => setTimeout(r, 3000));
  const addr = tw.address.fromHex(tx.contract_address);
  console.log(`   ${label}: ${addr}`);
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

async function main() {
  const { ethers } = hre;
  const accts: any = await fetch(`${HOST}/admin/accounts-json`).then(r => r.json());
  tw = new TronWeb({ fullHost: HOST, privateKey: accts.privateKeys[0] });
  me = tw.address.fromPrivateKey(accts.privateKeys[0]);
  meHex = "0x" + tw.address.toHex(me).slice(2);
  console.log(`local TVM: ${HOST}\nsigner   : ${me}\n`);

  // ─────────────────────────────── PART A — TOKEN ───────────────────────────────
  console.log("PART A — token upgrade from mainnet's starting state\n");
  const v2 = await deploy("MainnetReplicaV2Token", [], "v2 token replica");
  const v3 = await deploy("IDRP", [], "v3 token");
  const v3b = await deploy("IDRP", [], "v3 token (second)");
  const initV2 = new ethers.Interface(["function initialize(address)"])
    .encodeFunctionData("initialize", [meHex]);
  const proxy = await deploy("ERC1967Proxy", [tw.address.toHex(v2), initV2], "token proxy");

  console.log("\n  A1 — starting state matches live mainnet");
  const live = { frozen: 504, depositoryWallet: 505, maxSupply: 506, upgrader: 507 };
  const upg = asAddr(await storage(proxy, "0x" + live.upgrader.toString(16)));
  record("upgrader at slot 507", upg.toLowerCase() === meHex.toLowerCase(), upg);
  for (const n of PROXY_SLOT_NAMES) {
    const v = await storage(proxy, ethers.keccak256(ethers.toUtf8Bytes(n)));
    record(`${n} empty`, isEmpty(v));
  }

  const v2Art = await hre.artifacts.readArtifact("MainnetReplicaV2Token");
  const t2 = await tw.contract(v2Art.abi, proxy);
  const sym = (await t2.symbol().call()).toString();
  record("ERC20 readable through the proxy", sym.length > 0, `symbol=${sym}`);

  console.log("\n  A2 — DOMAIN_SEPARATOR before the upgrade (EIP712 alignment)");
  const dsBefore = (await t2.DOMAIN_SEPARATOR().call()).toString();
  record("DOMAIN_SEPARATOR non-zero before", !/^0x?0*$/.test(dsBefore), dsBefore.slice(0, 18) + "…");

  console.log("\n  A3 — atomic upgradeToAndCall(v3, initializeV3)");
  const initV3 = new ethers.Interface(["function initializeV3(address,address,address)"])
    .encodeFunctionData("initializeV3", [meHex, meHex, meHex]);
  await t2.scheduleUpgrade(v3).send({ feeLimit: 500_000_000, shouldPollResponse: true });
  const delay = Number(await t2.UPGRADE_DELAY().call());
  console.log(`     scheduled; UPGRADE_DELAY=${delay}s — waiting`);
  await new Promise(r => setTimeout(r, delay * 1000 + 5000));
  await t2.upgradeToAndCall(v3, initV3).send({ feeLimit: 1_000_000_000, callValue: 0, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, 4000));
  const implNow = asAddr(await storage(proxy, IMPL_SLOT));
  record("upgraded to v3", implNow.toLowerCase() === ("0x" + tw.address.toHex(v3).slice(2)).toLowerCase(), implNow);

  console.log("\n  A4 — v3 state and permit() integrity");
  const v3Art = await hre.artifacts.readArtifact("IDRP");
  const t3 = await tw.contract(v3Art.abi, proxy);
  const dsAfter = (await t3.DOMAIN_SEPARATOR().call()).toString();
  record("DOMAIN_SEPARATOR unchanged by the upgrade", dsAfter === dsBefore,
    dsAfter === dsBefore ? "identical" : `${dsBefore.slice(0, 14)}… -> ${dsAfter.slice(0, 14)}…`);
  record("nonces() reachable (permit path alive)", true,
    `nonces(signer)=${(await t3.nonces(meHex).call()).toString()}`);
  for (const f of ["upgrader", "admin", "controller"]) {
    const v = (await t3[f]().call()).toString();
    record(`${f}() correct`, v.toLowerCase().endsWith(meHex.slice(2).toLowerCase()), v);
  }
  const symAfter = (await t3.symbol().call()).toString();
  record("ERC20 state preserved", symAfter === sym, `symbol=${symAfter}`);

  console.log("\n  A5 — still upgradeable afterwards");
  await t3.scheduleUpgrade(v3b).send({ feeLimit: 500_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, delay * 1000 + 5000));
  await t3.upgradeTo(v3b).send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, 4000));
  const impl2 = asAddr(await storage(proxy, IMPL_SLOT));
  record("second upgrade succeeded", impl2.toLowerCase() === ("0x" + tw.address.toHex(v3b).slice(2)).toLowerCase(), impl2);

  // ──────────────────────── PART B — TronUUPS on real TVM ────────────────────────
  console.log("\n\nPART B — TronUUPSUpgradeable on TVM (the in-house variant)\n");
  const slotImpl = await deploy("StorageSlotUUPSMock", [], "TronUUPS impl");
  const slotImplB = await deploy("StorageSlotUUPSMock", [], "TronUUPS impl (second)");
  const mockArt = await hre.artifacts.readArtifact("StorageSlotUUPSMock");

  console.log("\n  B1 — a FRESH proxy initialised BY the TronUUPS impl");
  const initMock = new ethers.Interface(["function initialize()"]).encodeFunctionData("initialize", []);
  const freshProxy = await deploy("ERC1967Proxy", [tw.address.toHex(slotImpl), initMock], "fresh proxy");
  const pSlot = await storage(freshProxy, ethers.keccak256(ethers.toUtf8Bytes("idrp.tron.uups.__proxy")));
  const wantProxy = "0x" + tw.address.toHex(freshProxy).slice(2);
  record("initialize() wrote the proxy slot", asAddr(pSlot).toLowerCase() === wantProxy.toLowerCase(), asAddr(pSlot));

  const fm = await tw.contract(mockArt.abi, freshProxy);
  let freshUpgraded = false;
  try {
    await fm.upgradeTo(slotImplB).send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, 3000));
    freshUpgraded = asAddr(await storage(freshProxy, IMPL_SLOT)).toLowerCase()
      === ("0x" + tw.address.toHex(slotImplB).slice(2)).toLowerCase();
  } catch { freshUpgraded = false; }
  record("fresh TronUUPS proxy CAN upgrade", freshUpgraded,
    "this is the case Bontor validated — it works");

  console.log("\n  B2 — a pre-existing proxy upgraded INTO the TronUUPS impl");
  const preV2 = await deploy("MainnetReplicaV2Token", [], "v2 replica (pre-existing)");
  const preProxy = await deploy("ERC1967Proxy",
    [tw.address.toHex(preV2), initV2], "pre-existing proxy");
  const pre = await tw.contract(v2Art.abi, preProxy);
  await pre.scheduleUpgrade(slotImpl).send({ feeLimit: 500_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, delay * 1000 + 5000));
  await pre.upgradeTo(slotImpl).send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, 4000));
  const swapped = asAddr(await storage(preProxy, IMPL_SLOT)).toLowerCase()
    === ("0x" + tw.address.toHex(slotImpl).slice(2)).toLowerCase();
  record("upgrade INTO the TronUUPS impl succeeds", swapped, "the old impl performs it and never checks the slot");
  const preSlot = await storage(preProxy, ethers.keccak256(ethers.toUtf8Bytes("idrp.tron.uups.__proxy")));
  record("proxy slot is still EMPTY afterwards", isEmpty(preSlot), "no initializer ran");

  const stuck = await tw.contract(mockArt.abi, preProxy);
  let frozen = false;
  try {
    await stuck.upgradeTo(slotImplB).send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, 3000));
    frozen = asAddr(await storage(preProxy, IMPL_SLOT)).toLowerCase()
      !== ("0x" + tw.address.toHex(slotImplB).slice(2)).toLowerCase();
  } catch { frozen = true; }
  record("...and the NEXT upgrade is blocked — proxy frozen", frozen,
    "TronUUPSUnauthorizedCallContext: this is what froze the Nile Controller");

  console.log("\n\n=== SUITE SUMMARY ===");
  const failed = results.filter(([, p]) => !p);
  results.forEach(([n, p, d]) => console.log(`  ${ok(p)} ${n}${d ? "  (" + d + ")" : ""}`));
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("  FAILURES:"); failed.forEach(([n]) => console.log("   - " + n)); process.exit(1); }
}
main().then(() => process.exit(0)).catch(e => { console.error("\n✗", e.message || JSON.stringify(e)); process.exit(1); });

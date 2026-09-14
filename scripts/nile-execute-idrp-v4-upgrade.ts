/**
 * Nile: execute the scheduled upgrade to the FINAL token implementation — the one
 * that seizes into `confiscationWallet`.
 *
 *   npx hardhat run scripts/nile-execute-idrp-v4-upgrade.ts --network nile
 *
 * Uses upgradeTo, NOT upgradeToAndCall. This hop has no initializer to run: the Tron
 * lineage has no initializeV4, and initializeV3 was consumed by the previous upgrade
 * (_initialized == 3). On OZ 4.x `upgradeToAndCall(impl, "0x")` passes forceCall=true
 * and ALWAYS reverts, so a "no-data atomic upgrade" is not a thing here — see the
 * matching assertion in test/upgrade/TronBattleTest.ts.
 *
 * Waits for the timelock rather than assuming it has passed, simulates before sending,
 * and verifies the result by reading the chain rather than trusting the broadcast.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://nile.trongrid.io";
const PROXY_T = "TYdq9kGJQDSVxPeKH1zyXMuTgKK56tv1GU";
const PROXY = "0xf8a0c0078a0ac425f91240432ca90b9205b669ed";
const I1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown, label: string): Promise<any> {
  let last: unknown;
  for (let a = 0; a < 6; a++) {
    if (a) await sleep(900 * a);
    try {
      const j = await (await fetch(HOST + path, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      })).json() as any;
      if (j?.Error || j?.error) { last = new Error("rpc"); continue; }
      return j;
    } catch (e) { last = e; }
  }
  throw new Error(`READ FAILED (${label}): ${String((last as any)?.message).slice(0, 60)}`);
}
const rpc = async (method: string, params: unknown[], label: string) => {
  const j = await post("/jsonrpc", { jsonrpc: "2.0", id: 1, method, params }, label);
  if (j.result === undefined) throw new Error(`READ FAILED (${label}): no result`);
  return j.result as string;
};

async function main() {
  if (hre.network.name !== "nile") throw new Error(`nile only (got ${hre.network.name})`);
  const { ethers } = hre;
  const call = async (sig: string) => rpc("eth_call", [{ to: PROXY, data: ethers.id(sig).slice(0, 10) }, "latest"], sig);

  const scheduled = "0x" + (await call("scheduledImplementation()")).slice(26);
  if (BigInt(scheduled) === 0n) throw new Error("nothing scheduled");
  const delay = BigInt(await call("UPGRADE_DELAY()"));
  const at = BigInt(await call("upgradeScheduledAt()"));
  const execAfter = at + delay;
  console.log(`scheduled impl   ${scheduled}`);
  console.log(`executable after ${new Date(Number(execAfter) * 1000).toISOString()}`);

  for (let i = 0; i < 60; i++) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now >= execAfter) break;
    const left = Number(execAfter - now);
    console.log(`  waiting ${left}s …`);
    await sleep(Math.min(left + 3, 30) * 1000);
  }
  if (BigInt(Math.floor(Date.now() / 1000)) < execAfter) throw new Error("timelock still not expired");

  const before = {
    admin: "0x" + (await call("admin()")).slice(26),
    controller: "0x" + (await call("controller()")).slice(26),
    upgrader: "0x" + (await call("upgrader()")).slice(26),
    supply: BigInt(await call("totalSupply()")),
    depository: "0x" + (await call("depositoryWallet()")).slice(26),
  };
  console.log(`\npre-upgrade: controller=${before.controller} supply=${before.supply}`);

  const { vars } = require("hardhat/config");
  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const meT = tw.address.fromPrivateKey(pk);

  const param = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [scheduled]).slice(2);
  const sim = await post("/wallet/triggerconstantcontract",
    { owner_address: meT, contract_address: PROXY_T, function_selector: "upgradeTo(address)", parameter: param, visible: true }, "sim");
  const cr = (sim.constant_result || [])[0];
  if (cr === undefined) throw new Error("simulation returned nothing — inconclusive, not a pass");
  if (cr) {
    let why = `custom 0x${cr.slice(0, 8)}`;
    if (cr.startsWith("08c379a0")) {
      try { why = `"${ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + cr.slice(8))[0]}"`; } catch { /* keep */ }
    }
    throw new Error(`simulation REVERTS ${why} — not sending`);
  }
  console.log(`simulation: would succeed`);

  const built = await tw.transactionBuilder.triggerSmartContract(
    tw.address.toHex(PROXY_T), "upgradeTo(address)",
    { feeLimit: 300_000_000, callValue: 0, rawParameter: param }, [], tw.address.toHex(meT));
  const sent = await tw.trx.sendRawTransaction(await tw.trx.sign(built.transaction));
  const txid = sent.txid ?? built.transaction.txID;
  console.log(`\nupgradeTo(${scheduled})\n  txid ${txid}`);

  let receipt = "";
  for (let i = 0; i < 25; i++) {
    await sleep(3000);
    const info = await post("/wallet/gettransactioninfobyid", { value: txid }, "receipt");
    if (info?.receipt?.result) {
      receipt = info.receipt.result;
      console.log(`  receipt ${receipt}  (block ${info.blockNumber}, energy ${info.receipt.energy_usage_total})`);
      if (info.resMessage) console.log(`  ${Buffer.from(info.resMessage, "hex").toString()}`);
      break;
    }
  }
  if (receipt !== "SUCCESS") throw new Error(`upgrade did not succeed: ${receipt || "no receipt"}`);

  const live = "0x" + (await rpc("eth_getStorageAt", [PROXY, I1967, "latest"], "1967")).slice(26);
  const code = (await rpc("eth_getCode", [live, "latest"], "code")).toLowerCase();
  const after = {
    admin: "0x" + (await call("admin()")).slice(26),
    controller: "0x" + (await call("controller()")).slice(26),
    upgrader: "0x" + (await call("upgrader()")).slice(26),
    supply: BigInt(await call("totalSupply()")),
    depository: "0x" + (await call("depositoryWallet()")).slice(26),
    confiscation: "0x" + (await call("confiscationWallet()")).slice(26),
  };
  console.log(`\nPost-upgrade (read from the chain):`);
  console.log(`  live impl            ${live}  ${live === scheduled ? "✓" : "*** MISMATCH ***"}`);
  console.log(`  setConfiscationWallet ${code.includes(ethers.id("setConfiscationWallet(address)").slice(2, 10)) ? "present ✓" : "ABSENT ✗"}`);
  console.log(`  admin                ${after.admin}  ${after.admin === before.admin ? "✓ preserved" : "*** CHANGED ***"}`);
  console.log(`  controller           ${after.controller}  ${after.controller === before.controller ? "✓ preserved" : "*** CHANGED ***"}`);
  console.log(`  upgrader             ${after.upgrader}  ${after.upgrader === before.upgrader ? "✓ preserved" : "*** CHANGED ***"}`);
  console.log(`  depositoryWallet     ${after.depository}  ${after.depository === before.depository ? "✓ preserved" : "*** CHANGED ***"}`);
  console.log(`  totalSupply          ${after.supply}  ${after.supply === before.supply ? "✓ preserved" : "*** CHANGED ***"}`);
  console.log(`  confiscationWallet   ${after.confiscation}  ${BigInt(after.confiscation) === 0n ? "(unset — a seizure will revert until it is chosen)" : ""}`);
  console.log(`  scheduledImpl        ${"0x" + (await call("scheduledImplementation()")).slice(26)} (consumed)`);

  const bad = [after.admin !== before.admin, after.controller !== before.controller,
               after.upgrader !== before.upgrader, after.supply !== before.supply,
               after.depository !== before.depository, live !== scheduled].filter(Boolean).length;
  if (bad) throw new Error(`${bad} invariant(s) broke — investigate before using this proxy`);
  console.log(`\nAll invariants held.`);
  console.log(`REMAINING: setConfiscationWallet(<destination>) — a business decision, deliberately not chosen here.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

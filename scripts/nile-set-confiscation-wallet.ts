/**
 * Nile: point the token's `confiscationWallet` at the designated Tron seizure wallet.
 *
 *   npx hardhat run scripts/nile-set-confiscation-wallet.ts --network nile
 *   WALLET=T... to override the default.
 *
 * `setConfiscationWallet` is onlyAdmin and takes effect immediately — there is no
 * timelock by design (docs/design/confiscation-wallet-no-timelock.md). Simulated before
 * sending, and the result is read back from the chain rather than trusted from the
 * broadcast.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://nile.trongrid.io";
const TOKEN_T = "TYdq9kGJQDSVxPeKH1zyXMuTgKK56tv1GU";
const TOKEN = "0xf8a0c0078a0ac425f91240432ca90b9205b669ed";
const DEFAULT_WALLET = "TFkCwh84FnuwwNq4RLvr1j6T42d93cyg2n";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown, label: string): Promise<any> {
  let last: unknown;
  for (let a = 0; a < 6; a++) {
    if (a) await sleep(900 * a);
    try {
      const j = await (await fetch(HOST + path, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000) })).json() as any;
      if (j?.Error || j?.error) { last = new Error("rpc"); continue; }
      return j;
    } catch (e) { last = e; }
  }
  throw new Error(`READ FAILED (${label})`);
}
const call = async (sig: string, ethers: any) => {
  const j = await post("/jsonrpc", { jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: TOKEN, data: ethers.id(sig).slice(0, 10) }, "latest"] }, sig);
  return j.result as string;
};

async function main() {
  if (hre.network.name !== "nile") throw new Error(`nile only (got ${hre.network.name})`);
  const { ethers } = hre;
  const walletT = process.env.WALLET ?? DEFAULT_WALLET;

  const { vars } = require("hardhat/config");
  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const meT = tw.address.fromPrivateKey(pk);
  if (!tw.isAddress(walletT)) throw new Error(`not a Tron address: ${walletT}`);
  const walletHex = "0x" + tw.address.toHex(walletT).slice(2);

  const admin = "0x" + (await call("admin()", ethers)).slice(26);
  const current = "0x" + (await call("confiscationWallet()", ethers)).slice(26);
  console.log(`token            ${TOKEN_T}`);
  console.log(`admin()          ${admin}`);
  console.log(`caller           ${"0x" + tw.address.toHex(meT).slice(2)}  (${meT})`);
  if (admin.toLowerCase() !== ("0x" + tw.address.toHex(meT).slice(2)).toLowerCase()) {
    throw new Error("caller is not admin — setConfiscationWallet is onlyAdmin");
  }
  console.log(`\nconfiscationWallet`);
  console.log(`  before         ${BigInt(current) === 0n ? "UNSET" : current}`);
  console.log(`  after          ${walletHex}  (${walletT})`);
  if (current.toLowerCase() === walletHex.toLowerCase()) { console.log(`\nAlready set.`); return; }

  const param = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [walletHex]).slice(2);
  const sim = await post("/wallet/triggerconstantcontract", { owner_address: meT,
    contract_address: TOKEN_T, function_selector: "setConfiscationWallet(address)",
    parameter: param, visible: true }, "sim");
  const cr = (sim.constant_result || [])[0];
  if (cr === undefined) throw new Error("simulation returned nothing — inconclusive, not a pass");
  if (cr) {
    let why = `custom 0x${cr.slice(0, 8)}`;
    if (cr.startsWith("08c379a0")) {
      try { why = `"${ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + cr.slice(8))[0]}"`; } catch { /* keep */ }
    }
    throw new Error(`simulation REVERTS ${why} — not sending`);
  }
  console.log(`\nsimulation: would succeed`);

  const built = await tw.transactionBuilder.triggerSmartContract(
    tw.address.toHex(TOKEN_T), "setConfiscationWallet(address)",
    { feeLimit: 200_000_000, callValue: 0, rawParameter: param }, [], tw.address.toHex(meT));
  const sent = await tw.trx.sendRawTransaction(await tw.trx.sign(built.transaction));
  const txid = sent.txid ?? built.transaction.txID;
  console.log(`  txid ${txid}`);

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
  if (receipt !== "SUCCESS") throw new Error(`did not succeed: ${receipt || "no receipt"}`);

  const after = "0x" + (await call("confiscationWallet()", ethers)).slice(26);
  const dep = "0x" + (await call("depositoryWallet()", ethers)).slice(26);
  console.log(`\nread back from the chain:`);
  console.log(`  confiscationWallet ${after}  ${after.toLowerCase() === walletHex.toLowerCase() ? "✓" : "✗ MISMATCH"}`);
  console.log(`  depositoryWallet   ${dep}  ${dep.toLowerCase() !== after.toLowerCase() ? "✓ still separate" : "✗ same address"}`);
  if (after.toLowerCase() !== walletHex.toLowerCase()) throw new Error("value did not stick");
}
main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

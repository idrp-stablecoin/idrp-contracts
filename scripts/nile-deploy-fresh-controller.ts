/**
 * Nile: stand up a REPLACEMENT IDRPController proxy.
 *
 *   STEP=deploy  npx hardhat run scripts/nile-deploy-fresh-controller.ts --network nile
 *   STEP=roles   …
 *   STEP=rules   …
 *   STEP=verify  …
 *
 * WHY A NEW PROXY
 *   The original Controller TWTjirsqPT6DGC63RMSAHGtb2NdzauiJWy is permanently
 *   un-upgradeable: its implementation inherits TronUUPSUpgradeable, whose onlyProxy
 *   requires address(this) == sload(keccak256("idrp.tron.uups.__proxy")), and that slot
 *   is zero. The only function that writes it is initialize(), which _initialized == 1
 *   consumed. Measured, not inferred — see the BLOCKER note in notes/.
 *
 *   The implementation used here inherits TronGaplessUUPSUpgradeable instead, which keeps
 *   OZ's `immutable __self`, so there is no slot to forget and this cannot recur. STEP=deploy
 *   proves that by simulating upgradeTo and asserting the revert is the ordinary
 *   "Upgrade not scheduled" rather than TronUUPSUnauthorizedCallContext().
 *
 *   A Controller holds no balances, so only the address is lost. Roles and quorum rules are
 *   restored from notes/incidents/nile-recovery/ — a fresh proxy starts with NONE.
 *
 * Calldata is built with ethers and sent as rawParameter so TronWeb never has to encode the
 * tuple[] argument of setQuorumRules.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://nile.trongrid.io";
const IMPL = "0x1674484ed9b9915c6be56103c2829673a457e075";
const TOKEN_PROXY = "0xf8a0c0078a0ac425f91240432ca90b9205b669ed";
const DEPLOY_KEY = "IDRPController_v4_Proxy_Nile";

const MAX = (1n << 256n) - 1n;
const ROLE_HOLDERS: Array<[string, string]> = [
  ["OFFICER_ROLE", "0xabdaa2fa14d78b83d9dfa84d417dff9300d6eec3"],
  ["OFFICER_ROLE", "0xed28d6c2973c49fe83eca2302a703dd9c8e9dd9b"],
  ["MANAGER_ROLE", "0xa06f190b4e65f084ed9917ef1fe30121792d8304"],
  ["DIRECTOR_ROLE", "0x32f48dda37a30554163e30b62cfb98de50c2ed58"],
  ["COMMISSIONER_ROLE", "0xadde3172cad70db46766e75076adcfcaaa6ac390"],
];
const O = "OFFICER_ROLE", M = "MANAGER_ROLE", D = "DIRECTOR_ROLE", C = "COMMISSIONER_ROLE";
// Restored verbatim from notes/incidents/nile-recovery/quorum-rules-v2-snapshot.json.
// Confiscate is NEW: single tier by design — _validateQuorumRules rejects multi-tier for it,
// so `amount` can never select a cheaper quorum.
const RULES: Array<[number, string, Array<[bigint, bigint, string[]]>]> = [
  [0, "Mint", [[0n, 500_000_000_000_000n, [O, M]], [500_000_000_000_000n, 1_000_000_000_000_000n, [O, M, D]], [1_000_000_000_000_000n, MAX, [O, M, D, C]]]],
  [1, "Burn", [[0n, 500_000_000_000_000n, [O, M]], [500_000_000_000_000n, 1_000_000_000_000_000n, [O, M, D]], [1_000_000_000_000_000n, MAX, [O, M, D, C]]]],
  [2, "Freeze", [[0n, 500_000_000_000_000n, [O]], [500_000_000_000_000n, 1_000_000_000_000_000n, [O, M]], [1_000_000_000_000_000n, 10_000_000_000_000_000n, [O, M, D]], [10_000_000_000_000_000n, MAX, [O, M, D, C]]]],
  [3, "Unfreeze", [[0n, 500_000_000_000_000n, [O]], [500_000_000_000_000n, 1_000_000_000_000_000n, [O, M]], [1_000_000_000_000_000n, 10_000_000_000_000_000n, [O, M, D]], [10_000_000_000_000_000n, MAX, [O, M, D, C]]]],
  [4, "Pause", [[0n, MAX, [M, D]]]],
  [5, "Unpause", [[0n, MAX, [O, M, D, C]]]],
  [6, "Confiscate", [[0n, MAX, [O, M, D, C]]]],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown, label: string): Promise<any> {
  let last: unknown;
  for (let a = 0; a < 6; a++) {
    await sleep(700);
    try {
      const j = await (await fetch(HOST + path, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
      })).json();
      if (j && j.Error) { last = new Error(j.Error); continue; }
      return j;
    } catch (e) { last = e; }
  }
  throw new Error(`READ FAILED (${label}): ${String((last as any)?.message).slice(0, 90)}`);
}
const storageAt = async (a: string, s: string) =>
  (await post("/jsonrpc", { jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [a, s, "latest"] }, `slot ${s}`)).result;

async function constCall(proxyT: string, owner: string, selector: string, param: string) {
  const r = await post("/wallet/triggerconstantcontract",
    { owner_address: owner, contract_address: proxyT, function_selector: selector, parameter: param, visible: true }, selector);
  return { raw: (r.constant_result || [])[0] as string | undefined, msg: r.result?.message };
}

async function send(tw: any, proxyT: string, meT: string, selector: string, calldata: string, label: string) {
  const built = await tw.transactionBuilder.triggerSmartContract(
    tw.address.toHex(proxyT), selector,
    { feeLimit: 300_000_000, callValue: 0, rawParameter: calldata.slice(10) },
    [], tw.address.toHex(meT));
  const txid = (await tw.trx.sendRawTransaction(await tw.trx.sign(built.transaction))).txid
    ?? built.transaction.txID;
  for (let i = 0; i < 25; i++) {
    await sleep(3000);
    const info = await post("/wallet/gettransactioninfobyid", { value: txid }, "receipt");
    if (info?.receipt?.result) {
      const ok = info.receipt.result === "SUCCESS";
      const why = info.resMessage ? Buffer.from(info.resMessage, "hex").toString() : "";
      console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(34)} ${info.receipt.result}${why ? " — " + why : ""}  (${txid.slice(0, 12)}…)`);
      if (!ok) throw new Error(`${label} failed: ${info.receipt.result} ${why}`);
      return txid;
    }
  }
  throw new Error(`${label}: no receipt after 75s — verify on-chain before retrying`);
}

async function main() {
  if (hre.network.name !== "nile") throw new Error(`nile only (got ${hre.network.name})`);
  const STEP = (process.env.STEP ?? "deploy").toLowerCase();
  const { ethers, deployments } = hre as any;
  const [signer] = await hre.ethers.getSigners();
  const me = await signer.getAddress();

  const { vars } = require("hardhat/config");
  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const meT = tw.address.fromPrivateKey(pk);
  const role = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));

  const prior = await deployments.getOrNull(DEPLOY_KEY);
  if (STEP !== "deploy" && !prior) throw new Error(`No ${DEPLOY_KEY} yet — run STEP=deploy first`);

  if (STEP === "deploy") {
    if (prior) { console.log(`Already deployed at ${prior.address} — nothing to do.`); return; }
    const initData = new ethers.Interface(["function initialize(address _idrpToken, address _safeAddress)"])
      .encodeFunctionData("initialize", [TOKEN_PROXY, me]);
    console.log(`impl        ${IMPL}`);
    console.log(`idrpToken   ${TOKEN_PROXY}`);
    console.log(`admin+upgrader (initialize _safeAddress) ${me}  (${meT})`);
    console.log(`\nDeploying ERC1967Proxy …`);
    const res = await deployments.deploy(DEPLOY_KEY, {
      from: me, contract: "ERC1967Proxy", args: [IMPL, initData],
      log: true, gasLimit: 10_000_000, gasPrice: "420",
    });
    const proxy = res.address.toLowerCase();
    const proxyT = tw.address.fromHex("41" + proxy.slice(2));
    console.log(`\n✓ proxy ${proxy}  (${proxyT})`);

    console.log(`\nPost-deploy state (read on-chain):`);
    for (const sig of ["defaultAdmin()", "upgrader()", "idrpToken()", "UPGRADE_DELAY()", "DOMAIN_SEPARATOR()"]) {
      const { raw: r } = await constCall(proxyT, meT, sig, "");
      if (!r) { console.log(`  ${sig.padEnd(22)} (no value)`); continue; }
      console.log(`  ${sig.padEnd(22)} ${/DELAY/.test(sig) ? BigInt("0x" + r) + " s" : /DOMAIN/.test(sig) ? "0x" + r : "0x" + r.slice(24)}`);
    }
    const implSlot = await storageAt(proxy, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    console.log(`  ERC-1967 impl          ${implSlot}`);

    // The whole point of the new proxy: the upgrade path must be reachable.
    const { raw: up } = await constCall(proxyT, meT, "upgradeTo(address)",
      ethers.AbiCoder.defaultAbiCoder().encode(["address"], ["0x0000000000000000000000000000000000000001"]).slice(2));
    const ctx = ethers.id("TronUUPSUnauthorizedCallContext()").slice(2, 10);
    let verdict = "UNKNOWN";
    if (up?.startsWith("08c379a0")) {
      const s = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + up.slice(8))[0];
      verdict = s === "Upgrade not scheduled" ? `"${s}"  -> upgrade path REACHABLE (healthy)` : `"${s}"`;
    } else if (up?.slice(0, 8) === ctx) verdict = "TronUUPSUnauthorizedCallContext()  -> TRAP PRESENT, STOP";
    else if (up) verdict = `custom 0x${up.slice(0, 8)}`;
    console.log(`\n  upgradeTo() sim        ${verdict}`);
    if (verdict.includes("TRAP")) throw new Error("new proxy carries the proxy-slot trap — do not use it");
    console.log(`\nNext: STEP=roles`);
    return;
  }

  const proxy = prior.address.toLowerCase();
  const proxyT = tw.address.fromHex("41" + proxy.slice(2));
  console.log(`proxy ${proxy}  (${proxyT})\n`);

  if (STEP === "roles") {
    const iface = new ethers.Interface(["function grantRole(bytes32 role, address account)"]);
    for (const [name, holder] of ROLE_HOLDERS) {
      const { raw: has } = await constCall(proxyT, meT, "hasRole(bytes32,address)",
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address"], [role(name), holder]).slice(2));
      if (has && BigInt("0x" + has)) { console.log(`  · ${name.padEnd(18)} ${holder} already held`); continue; }
      await send(tw, proxyT, meT, "grantRole(bytes32,address)",
        iface.encodeFunctionData("grantRole", [role(name), holder]), `${name} -> ${holder.slice(0, 10)}…`);
    }
    console.log(`\nNext: STEP=rules`);
    return;
  }

  if (STEP === "rules") {
    const iface = new ethers.Interface([
      "function setQuorumRules(uint8 operationType, (uint256 minAmount, uint256 maxAmount, bytes32[] requiredRoles)[] rules)",
    ]);
    for (const [op, name, tiers] of RULES) {
      const encoded = tiers.map(([mn, mx, rs]) => [mn, mx, rs.map(role)]);
      await send(tw, proxyT, meT, "setQuorumRules(uint8,(uint256,uint256,bytes32[])[])",
        iface.encodeFunctionData("setQuorumRules", [op, encoded]), `${name} (${tiers.length} tier)`);
    }
    console.log(`\nNext: STEP=verify`);
    return;
  }

  if (STEP === "verify") {
    console.log(`Roles:`);
    for (const [name, holder] of ROLE_HOLDERS) {
      const { raw: has } = await constCall(proxyT, meT, "hasRole(bytes32,address)",
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address"], [role(name), holder]).slice(2));
      console.log(`  ${has && BigInt("0x" + has) ? "✓" : "✗"} ${name.padEnd(18)} ${holder}`);
    }
    console.log(`\nQuorum rules (getQuorumRule at each tier's floor):`);
    const names: Record<string, string> = {};
    for (const n of [O, M, D, C]) names[role(n)] = n.replace("_ROLE", "");
    let bad = 0;
    for (const [op, name, tiers] of RULES) {
      for (const [mn, , want] of tiers) {
        const { raw: r } = await constCall(proxyT, meT, "getQuorumRule(uint8,uint256)",
          ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint256"], [op, mn]).slice(2));
        if (!r) { console.log(`  ✗ ${name} @${mn}: no value`); bad++; continue; }
        const [rule] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["tuple(uint256,uint256,bytes32[])"], "0x" + r);
        const got = rule[2].map((h: string) => names[h] ?? h);
        const ok = got.join(",") === want.map((w) => w.replace("_ROLE", "")).join(",");
        if (!ok) bad++;
        console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(11)} @${String(mn).padStart(18)}  ${got.join("+")}`);
      }
    }
    console.log(`\n${bad === 0 ? "All rules match the v2 snapshot (plus Confiscate)." : `${bad} MISMATCH(es) — fix before use.`}`);
    console.log(`\nStill to do once the token upgrade executes: setController(${proxy}) on the token,`);
    console.log(`then repoint the dashboard's Nile AppSettings controller address.`);
    return;
  }
  throw new Error(`unknown STEP=${STEP}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

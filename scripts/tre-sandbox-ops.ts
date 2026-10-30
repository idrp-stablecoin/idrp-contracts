/**
 * Local TVM only: drive real quorum operations against the testnet-env replica that
 * scripts/testnet-deploy-tron.ts --network tre built, before, during and after the v3
 * upgrade the tron-* scripts perform. The replica keeps the Nile wallets as its quorum
 * signers (no keys here), so `setup` adds TRE accounts to the same roles; nothing else
 * about the replica changes.
 *
 *   TRE_RECORD=<record> PHASE=setup  npx hardhat run scripts/tre-sandbox-ops.ts --network tre
 *   TRE_RECORD=<record> PHASE=v2     …   (controller v2, token v2)
 *   TRE_RECORD=<record> PHASE=mixed  …   (controller v3, token v2: the window between the two executes)
 *   TRE_RECORD=<record> PHASE=v3     …   (both v3)
 *   TRE_RECORD=<record> PHASE=hop TARGET=controller|token IMPL=T…   (a data-less v3 -> v3 upgradeTo)
 *   RUN=<tag> on a repeat run, so its identifiers are new
 *
 * Exit code 1 when any check fails. Signers: TRE accounts 1-5 (OFFICER, OFFICER, MANAGER,
 * DIRECTOR, COMMISSIONER); the submitter is the replica's deployer (the configured tre key).
 */
import fs from "fs";
import hre from "hardhat";
import { ethers } from "ethers";
import { tronNetwork, hexOf, type TronNet } from "./utils/tron-network";
import { decodeRevert, ethCall, waitReceipt } from "./utils/tron-preflight";

const HOST = "http://127.0.0.1:9090";
const SIGNER_ROLES = ["OFFICER_ROLE", "OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"];
const OP = { Mint: 0, Burn: 1, Freeze: 2, Unfreeze: 3, Pause: 4, Unpause: 5 } as const;
const ZERO = ethers.ZeroAddress;

const ctrlIface = new ethers.Interface([
  "function grantRole(bytes32,address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getOperationHash(address,uint8,uint256,string,uint256) view returns (bytes32)",
  "function executeOperation(uint8,address,uint256,string,uint256,bytes[])",
  "error NotUpgrader()",
]);
const tokenIface = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function frozen(address) view returns (bool)",
  "function paused() view returns (bool)",
]);

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = "") {
  results.push([name, pass, detail]);
  console.log(`   ${pass ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}

let net: TronNet;
let signerKeys: string[] = [];

async function view(to: string, iface: ethers.Interface, fn: string, args: unknown[] = []) {
  const out = await ethCall(net, hexOf(net, to), iface.encodeFunctionData(fn, args));
  if (out === null) throw new Error(`${fn} reverted`);
  const r = iface.decodeFunctionResult(fn, out);
  return r.length === 1 ? r[0] : r;
}

async function send(to: string, iface: ethers.Interface, fn: string, args: unknown[]): Promise<{ ok: boolean; reason: string }> {
  const frag = iface.getFunction(fn)!;
  const data = iface.encodeFunctionData(frag, args);
  const built = await net.tw.transactionBuilder.triggerSmartContract(
    net.tw.address.toHex(to), frag.format("sighash"), { feeLimit: 1_000_000_000, callValue: 0, rawParameter: data.slice(10) }, [], net.tw.address.toHex(net.signer),
  );
  const res = await net.tw.trx.sendRawTransaction(await net.tw.trx.sign(built.transaction));
  if (!res.result) throw new Error(`broadcast ${fn} failed: ${JSON.stringify(res)}`);
  const info = await waitReceipt(net, built.transaction.txID, fn);
  const ok = info.receipt?.result === "SUCCESS";
  const combined = new ethers.Interface([...iface.fragments, ...ctrlIface.fragments.filter((f) => f.type === "error")]);
  return { ok, reason: ok ? "" : info.contractResult?.[0] ? decodeRevert(info.contractResult[0], combined) : String(info.receipt?.result) };
}

let lastDeadline = 0n;
/** Every call gets a deadline later than the previous one, so a repeated identifier is always a NEW digest. */
async function op(type: number, to: string, amount: bigint, id: string, signers = [0, 2, 3, 4]) {
  const wall = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const deadline = wall > lastDeadline ? wall : lastDeadline + 1n;
  lastDeadline = deadline;
  const digest: string = await view(net.controller, ctrlIface, "getOperationHash", [to, type, amount, id, deadline]);
  const sigs = signers.map((i) => new ethers.SigningKey("0x" + signerKeys[i]).sign(digest).serialized);
  return send(net.controller, ctrlIface, "executeOperation", [type, to, amount, id, deadline, sigs]);
}

async function main() {
  net = await tronNetwork(hre);
  if (net.name !== "tre") throw new Error("local TVM only (--network tre)");
  const accts: any = await fetch(`${HOST}/admin/accounts-json`).then((r) => r.json());
  signerKeys = accts.privateKeys.slice(1, 6);
  const signerAddr = signerKeys.map((k) => ethers.computeAddress("0x" + k).toLowerCase());
  const phase = process.env.PHASE ?? "";
  const statePath = net.recordPath.replace(/\.json$/, ".ops.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const token = net.token;
  const depository = hexOf(net, net.record.depositoryWallet);
  const supply = async () => BigInt(await view(token, tokenIface, "totalSupply"));
  const ONE = 10n ** 6n;

  console.log(`PHASE ${phase} — token ${token}, controller ${net.controller}`);
  if (phase === "setup") {
    for (let i = 0; i < SIGNER_ROLES.length; i++) {
      const r = await send(net.controller, ctrlIface, "grantRole", [ethers.id(SIGNER_ROLES[i]), signerAddr[i]]);
      check(`grant ${SIGNER_ROLES[i]} to TRE account ${i + 1}`, r.ok && (await view(net.controller, ctrlIface, "hasRole", [ethers.id(SIGNER_ROLES[i]), signerAddr[i]])), r.reason);
    }
    state.frozenAccount = ethers.Wallet.createRandom().address.toLowerCase();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`   account to freeze across the upgrade: ${net.tw.address.fromHex("41" + state.frozenAccount.slice(2))}`);
  } else if (phase === "v2" || phase === "mixed" || phase === "v3") {
    // RUN=<tag> gives a repeat run fresh identifiers; the same ones are (correctly) refused the second time.
    const tag = `tre-${phase}${process.env.RUN ? "-" + process.env.RUN : ""}`;
    const s0 = await supply();
    const m = await op(OP.Mint, ZERO, 5n * ONE, `${tag}-mint`);
    check(`${phase}: quorum Mint executes`, m.ok && (await supply()) === s0 + 5n * ONE, m.reason);
    const again = await op(OP.Mint, ZERO, 5n * ONE, `${tag}-mint`);
    if (phase === "v2") {
      check(`v2: same identifier with a new deadline is ACCEPTED (the bug v3 fixes)`, again.ok, again.reason);
    } else {
      check(`${phase}: same identifier with a new deadline is refused`, !again.ok && again.reason.includes("Operation identifier already used"), again.reason);
      const empty = await op(OP.Mint, ZERO, ONE, "");
      check(`${phase}: an empty identifier is refused`, !empty.ok && empty.reason.includes("Operation identifier required"), empty.reason);
      const old = await op(OP.Mint, ZERO, ONE, "tre-v2-mint");
      check(`${phase}: a v2-era identifier under a new deadline — measured, not asserted`, true, old.ok ? "ACCEPTED (v2 recorded digests only; the RC documents this edge)" : `refused: ${old.reason}`);
    }
    const s1 = await supply();
    const b = await op(OP.Burn, depository, 2n * ONE, `${tag}-burn`);
    check(`${phase}: quorum Burn from the depository executes`, b.ok && (await supply()) === s1 - 2n * ONE, b.reason);
    if (phase === "v2") {
      const f = await op(OP.Freeze, state.frozenAccount, 0n, `${tag}-freeze`);
      check(`v2: quorum Freeze executes (account stays frozen across the upgrade)`, f.ok && (await view(token, tokenIface, "frozen", [state.frozenAccount])) === true, f.reason);
    } else {
      check(`${phase}: the account frozen under v2 is still frozen`, (await view(token, tokenIface, "frozen", [state.frozenAccount])) === true);
    }
    if (phase === "v3") {
      const u = await op(OP.Unfreeze, state.frozenAccount, 0n, `${tag}-unfreeze`);
      check(`v3: quorum Unfreeze executes`, u.ok && (await view(token, tokenIface, "frozen", [state.frozenAccount])) === false, u.reason);
      const f = await op(OP.Freeze, state.frozenAccount, 0n, `${tag}-refreeze`);
      check(`v3: quorum Freeze executes`, f.ok && (await view(token, tokenIface, "frozen", [state.frozenAccount])) === true, f.reason);
      const p = await op(OP.Pause, ZERO, 0n, `${tag}-pause`, [2, 3]);
      check(`v3: quorum Pause executes (MANAGER + DIRECTOR)`, p.ok && (await view(token, tokenIface, "paused")) === true, p.reason);
      const whilePaused = await op(OP.Mint, ZERO, ONE, `${tag}-mint-while-paused`);
      check(`v3: Mint while paused is refused`, !whilePaused.ok, whilePaused.reason);
      const up = await op(OP.Unpause, ZERO, 0n, `${tag}-unpause`, [0, 2, 3]);
      check(`v3: quorum Unpause executes (OFFICER + MANAGER + DIRECTOR)`, up.ok && (await view(token, tokenIface, "paused")) === false, up.reason);
    }
  } else if (phase === "hop") {
    // A data-less v3 -> v3 upgrade (upgradeTo: OZ 4's upgradeToAndCall forces a delegatecall even
    // with empty data). The scheduled implementation must already be past its delay.
    const target = (process.env.TARGET ?? "").toLowerCase();
    const proxy = target === "controller" ? net.controller : target === "token" ? token : "";
    if (!proxy || !process.env.IMPL) throw new Error("PHASE=hop needs TARGET=controller|token and IMPL=<scheduled implementation>");
    const impl = hexOf(net, process.env.IMPL);
    const upIface = new ethers.Interface(["function upgradeTo(address)", "error NotUpgrader()"]);
    const r = await send(proxy, upIface, "upgradeTo", [impl]);
    const slot = await (await import("./utils/tron-preflight")).getStorage(net, hexOf(net, proxy), "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    check(`${target}: upgradeTo(${process.env.IMPL}) lands`, r.ok && ("0x" + slot.slice(-40)).toLowerCase() === impl, r.reason);
  } else {
    throw new Error("PHASE=setup | v2 | mixed | v3 | hop");
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

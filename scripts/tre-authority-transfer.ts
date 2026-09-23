/**
 * Local TVM rehearsal of the Tron upgrade: token v2 -> v3 with the delayed
 * admin/upgrader handover, controller v2 -> v3 with the operation-identifier
 * guard, together, from the starting state Tron mainnet is in.
 *
 *   docker run -d --name idrp-tre -p 9090:9090 tronbox/tre
 *   npx hardhat run scripts/tre-authority-transfer.ts --network tre
 *
 * Fixtures (scripts/tvm/make-fixtures.ts) differ from the real sources only in
 * UPGRADE_DELAY / AUTHORITY_TRANSFER_DELAY (60s) and the contract name, so every
 * timelock — upgrades and both handovers — runs for real, just faster. V2 fixtures come from the
 * contracts/legacy sources proven byte-identical to the Tron mainnet
 * implementations.
 *
 * STEPS
 *   A. deploy v2 replicas behind proxies; give them history: balances, a
 *      frozen account, the four quorum roles
 *   B. schedule both upgrades, wait, then the two atomic upgradeToAndCall calls
 *      mainnet will make (initializeV3 on each)
 *   C. everything survived; nothing is pending; the handover slots start empty
 *   D. a quorum-signed Mint and Burn execute on TVM; the same identifier under
 *      a new deadline is refused
 *   E. admin and upgrader handovers on TVM: too-early accept refused, accept,
 *      cancel, old holders locked out
 *   F. the NEW upgrader upgrades the token twice more, the controller is
 *      upgraded twice more; state, roles, handover seats and the quorum path
 *      all still hold; no storage-slot proxy gate appeared
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "http://127.0.0.1:9090";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_SLOT_NAMES = ["idrp.tron.uups.__self", "idrp.tron.uups.__proxy"];

const TOKEN_V2 = "IDRPv2Tvm";
const TOKEN_V3 = "IDRPTvm";
const CTRL_V2 = "IDRPControllerv2Tvm";
const CTRL_V3 = "IDRPControllerTvm";
const ROLES = ["OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"];
const MAX = (1n << 256n) - 1n;

const { ethers } = hre;
let pks: string[] = [];
const results: [string, boolean, string][] = [];
const energy: [string, number][] = [];

const ok = (b: boolean) => (b ? "✓" : "✗");
function check(name: string, pass: boolean, detail = "") {
  results.push([name, pass, detail]);
  console.log(`   ${ok(pass)} ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tw = (i: number) => new TronWeb({ fullHost: HOST, privateKey: pks[i] });
const base58 = (i: number) => tw(0).address.fromPrivateKey(pks[i]);
const hex20 = (t: string) => "0x" + tw(0).address.toHex(t).slice(2);
const acct = (i: number) => hex20(base58(i));

async function rpc(method: string, params: any[]) {
  const j: any = await fetch(`${HOST}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  }).then((r) => r.json());
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function storage(addrT: string, slot: string | bigint) {
  const s = typeof slot === "bigint" ? ethers.toBeHex(slot, 32) : slot;
  return BigInt(await rpc("eth_getStorageAt", [hex20(addrT), s, "latest"]));
}

async function txInfo(txid: string) {
  for (let i = 0; i < 60; i++) {
    const info = await tw(0).trx.getTransactionInfo(txid);
    if (info && info.id) return info;
    await sleep(1000);
  }
  throw new Error(`no receipt for ${txid}`);
}

function revertReason(iface: any, info: any): string {
  const data = info.contractResult?.[0] ? "0x" + info.contractResult[0] : "0x";
  if (data.length >= 10) {
    try {
      const e = iface.parseError(data);
      if (e) return e.name === "Error" ? String(e.args[0]) : `${e.name}(${e.args.join(",")})`;
    } catch {}
  }
  return info.resMessage ? Buffer.from(info.resMessage, "hex").toString() : info.receipt?.result ?? "unknown";
}

async function deploy(name: string, label: string, params: any[] = []) {
  const a = await hre.artifacts.readArtifact(name);
  const w = tw(0);
  const tx = await w.transactionBuilder.createSmartContract(
    { abi: { entrys: a.abi }, bytecode: a.bytecode.replace(/^0x/, ""), feeLimit: 1_000_000_000, callValue: 0,
      userFeePercentage: 100, originEnergyLimit: 10_000_000, parameters: params, name: name.split(":").pop() },
    w.address.toHex(base58(0))
  );
  const res = await w.trx.sendRawTransaction(await w.trx.sign(tx));
  if (!res.result) throw new Error(`${label} deploy failed: ${JSON.stringify(res)}`);
  const info = await txInfo(tx.txID);
  if (info.receipt?.result && info.receipt.result !== "SUCCESS") throw new Error(`${label} deploy ${info.receipt.result}`);
  energy.push([`deploy ${label}`, info.receipt?.energy_usage_total ?? 0]);
  return w.address.fromHex(tx.contract_address) as string;
}

type Sent = { ok: boolean; reason: string; info: any };

/** Send a call from TRE account `from`, ABI-encoded by ethers, broadcast by TronWeb. */
async function send(from: number, to: string, iface: any, fn: string, args: any[], label?: string): Promise<Sent> {
  const w = tw(from);
  const frag = iface.getFunction(fn);
  const data = iface.encodeFunctionData(frag, args);
  const built = await w.transactionBuilder.triggerSmartContract(
    to, frag.format("sighash"), { feeLimit: 1_000_000_000, callValue: 0, rawParameter: data.slice(10) }, [], base58(from)
  );
  if (!built?.result?.result) throw new Error(`build ${fn} failed: ${JSON.stringify(built)}`);
  const res = await w.trx.sendRawTransaction(await w.trx.sign(built.transaction));
  if (!res.result) throw new Error(`broadcast ${fn} failed: ${JSON.stringify(res)}`);
  const info = await txInfo(built.transaction.txID);
  const success = info.receipt?.result === "SUCCESS";
  if (label && success) energy.push([label, info.receipt?.energy_usage_total ?? 0]);
  return { ok: success, reason: success ? "" : revertReason(iface, info), info };
}

async function must(from: number, to: string, iface: any, fn: string, args: any[], label?: string) {
  const r = await send(from, to, iface, fn, args, label);
  if (!r.ok) throw new Error(`${fn} reverted: ${r.reason}`);
  return r;
}

async function view(to: string, iface: any, fn: string, args: any[] = []) {
  const data = iface.encodeFunctionData(fn, args);
  const out = await rpc("eth_call", [{ from: acct(0), to: hex20(to), data }, "latest"]);
  const r = iface.decodeFunctionResult(fn, out);
  return r.length === 1 ? r[0] : r;
}

// TRE mines only when a transaction arrives, so the latest block's timestamp
// goes stale while nothing is sent. Wall-clock time is what the NEXT block will
// carry, so wait on that.
/** The handover pair's two slots, from the tron-solc layout of the token being deployed. */
async function handoverSlots(): Promise<[bigint, bigint]> {
  const fq = (await hre.artifacts.getAllFullyQualifiedNames()).find((q) => q.endsWith(`:${TOKEN_V3}`))!;
  const [src, name] = fq.split(":");
  const info = await hre.artifacts.getBuildInfo(fq);
  const entry = (info!.output.contracts as any)[src][name].storageLayout.storage.find(
    (s: any) => s.label === "_authorityTransfer"
  );
  if (!entry) throw new Error("no _authorityTransfer in the token layout");
  return [BigInt(entry.slot), BigInt(entry.slot) + 1n];
}

async function now() {
  return BigInt(Math.floor(Date.now() / 1000));
}

async function waitPast(schedule: bigint) {
  const ms = Number(schedule - (await now()) + 2n) * 1000;
  if (ms > 0) await sleep(ms);
}

async function main() {
  const accts: any = await fetch(`${HOST}/admin/accounts-json`).then((r) => r.json());
  pks = accts.privateKeys;
  if (pks.length < 10) throw new Error("TRE must expose at least 10 accounts");
  console.log(`local TVM ${HOST}; admin/upgrader = ${base58(0)}`);
  // Which compiler produced what is deployed here: it must be tron-solc.
  for (const n of [TOKEN_V2, TOKEN_V3, CTRL_V2, CTRL_V3]) {
    const fq = (await hre.artifacts.getAllFullyQualifiedNames()).find((q) => q.endsWith(`:${n}`))!;
    const info = await hre.artifacts.getBuildInfo(fq);
    console.log(`   ${n.padEnd(22)} compiled by ${info?.solcLongVersion} (${info?.input.settings.evmVersion})`);
  }
  console.log("");

  const tokenV3Iface = new ethers.Interface((await hre.artifacts.readArtifact(TOKEN_V3)).abi);
  const tokenV2Iface = new ethers.Interface((await hre.artifacts.readArtifact(TOKEN_V2)).abi);
  const ctrlV3Iface = new ethers.Interface((await hre.artifacts.readArtifact(CTRL_V3)).abi);
  const ctrlV2Iface = new ethers.Interface((await hre.artifacts.readArtifact(CTRL_V2)).abi);

  // Seats: 0 = today's upgrader/admin key, 1-4 = quorum signers,
  // 5 = next admin, 6 = next upgrader, 7 = a key that is never accepted,
  // 8 = depository, 9 = a holder.
  const [ME, NEW_ADMIN, NEW_UPGRADER, STRANGER, DEPO, HOLDER] = [0, 5, 6, 7, 8, 9];
  const frozen = ethers.Wallet.createRandom().address;

  console.log("A. v2 replicas with history");
  const tokenV2 = await deploy(TOKEN_V2, "token v2 (mainnet source)");
  const ctrlV2 = await deploy(CTRL_V2, "controller v2 (mainnet source)");
  const tokenV3 = [await deploy(TOKEN_V3, "token v3 #1"), await deploy(TOKEN_V3, "token v3 #2"), await deploy(TOKEN_V3, "token v3 #3")];
  const ctrlV3 = [await deploy(CTRL_V3, "controller v3 #1"), await deploy(CTRL_V3, "controller v3 #2"), await deploy(CTRL_V3, "controller v3 #3")];
  const token = await deploy("ERC1967Proxy", "token proxy", [
    tw(0).address.toHex(tokenV2), tokenV2Iface.encodeFunctionData("initialize", [acct(ME)]),
  ]);
  const ctrl = await deploy("ERC1967Proxy", "controller proxy", [
    tw(0).address.toHex(ctrlV2), ctrlV2Iface.encodeFunctionData("initialize", [hex20(token), acct(ME)]),
  ]);
  console.log(`   token proxy ${token}\n   controller proxy ${ctrl}`);

  const AMOUNT = 1_000_000n * 10n ** 6n;
  await must(ME, token, tokenV2Iface, "grantRole", [await view(token, tokenV2Iface, "MINTER_ROLE"), acct(ME)]);
  await must(ME, token, tokenV2Iface, "grantRole", [await view(token, tokenV2Iface, "FREEZER_ROLE"), acct(ME)]);
  await must(ME, token, tokenV2Iface, "setDepositoryWallet", [acct(DEPO)]);
  await must(ME, token, tokenV2Iface, "mint", [AMOUNT]);
  await must(DEPO, token, tokenV2Iface, "transfer", [acct(HOLDER), AMOUNT / 4n]);
  await must(ME, token, tokenV2Iface, "freeze", [frozen]);
  for (let i = 0; i < ROLES.length; i++) {
    await must(ME, ctrl, ctrlV2Iface, "grantRole", [await view(ctrl, ctrlV2Iface, ROLES[i]), acct(i + 1)]);
  }

  const tokenSnap = async (iface: any) => ({
    supply: await view(token, iface, "totalSupply"),
    depository: await view(token, iface, "balanceOf", [acct(DEPO)]),
    holder: await view(token, iface, "balanceOf", [acct(HOLDER)]),
    frozen: await view(token, iface, "frozen", [frozen]),
    domain: await view(token, iface, "DOMAIN_SEPARATOR"),
    symbol: await view(token, iface, "symbol"),
  });
  const rolesHeld = async (iface: any) => {
    let n = 0;
    for (let i = 0; i < ROLES.length; i++) if (await view(ctrl, iface, "hasRole", [await view(ctrl, iface, ROLES[i]), acct(i + 1)])) n++;
    return n;
  };
  const before = await tokenSnap(tokenV2Iface);
  const digestProbe = async (iface: any) => view(ctrl, iface, "getOperationHash", [ethers.ZeroAddress, 0, 1n, "tre-probe", 1n]);
  const digestBefore = await digestProbe(ctrlV2Iface);
  check("v2 token holds history", before.supply === AMOUNT && before.frozen === true, `supply ${before.supply}, holder ${before.holder}`);
  check("v2 controller holds the four quorum roles", (await rolesHeld(ctrlV2Iface)) === 4);
  const [hs0, hs1] = await handoverSlots();
  check(`handover slots ${hs0}/${hs1} empty on the v2 token`, (await storage(token, hs0)) === 0n && (await storage(token, hs1)) === 0n);

  console.log("\nB. the mainnet calls: schedule both, wait, atomic upgradeToAndCall(initializeV3) on both");
  await must(ME, token, tokenV2Iface, "scheduleUpgrade", [hex20(tokenV3[0])], "token scheduleUpgrade (v2)");
  await must(ME, ctrl, ctrlV2Iface, "scheduleUpgrade", [hex20(ctrlV3[0])], "controller scheduleUpgrade (v2)");
  const delay = BigInt(await view(token, tokenV2Iface, "UPGRADE_DELAY"));
  const scheduledAt = [
    BigInt(await view(token, tokenV2Iface, "upgradeScheduledAt")),
    BigInt(await view(ctrl, ctrlV2Iface, "upgradeScheduledAt")),
  ].reduce((a, b) => (a > b ? a : b));
  console.log(`   UPGRADE_DELAY ${delay}s — waiting`);
  await waitPast(scheduledAt + delay + 3n);
  await must(ME, token, tokenV2Iface, "upgradeToAndCall",
    [hex20(tokenV3[0]), tokenV3Iface.encodeFunctionData("initializeV3", [acct(ME), hex20(ctrl), acct(ME)])],
    "token upgradeToAndCall + initializeV3");
  await must(ME, ctrl, ctrlV2Iface, "upgradeToAndCall",
    [hex20(ctrlV3[0]), ctrlV3Iface.encodeFunctionData("initializeV3", [acct(ME), acct(ME), [acct(ME)]])],
    "controller upgradeToAndCall + initializeV3");
  check("token implementation is v3 #1", (await storage(token, IMPL_SLOT)) === BigInt(hex20(tokenV3[0])));
  check("controller implementation is v3 #1", (await storage(ctrl, IMPL_SLOT)) === BigInt(hex20(ctrlV3[0])));

  console.log("\nC. what survived");
  const afterMigration = await tokenSnap(tokenV3Iface);
  check("token balances, supply, freeze, permit domain unchanged", JSON.stringify(afterMigration, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(before, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  check("controller signing domain unchanged (same digest)", (await digestProbe(ctrlV3Iface)) === digestBefore);
  check("quorum roles survived without a re-grant", (await rolesHeld(ctrlV3Iface)) === 4);
  check("token wired: admin, upgrader, controller", (await view(token, tokenV3Iface, "admin")).toLowerCase() === acct(ME) && (await view(token, tokenV3Iface, "upgrader")).toLowerCase() === acct(ME) && (await view(token, tokenV3Iface, "controller")).toLowerCase() === hex20(ctrl));
  check("controller wired: defaultAdmin, upgrader, idrpToken", (await view(ctrl, ctrlV3Iface, "defaultAdmin")).toLowerCase() === acct(ME) && (await view(ctrl, ctrlV3Iface, "upgrader")).toLowerCase() === acct(ME) && (await view(ctrl, ctrlV3Iface, "idrpToken")).toLowerCase() === hex20(token));
  const pa = await view(token, tokenV3Iface, "pendingAdmin");
  const pu = await view(token, tokenV3Iface, "pendingUpgrader");
  check("nothing pending after migration", pa[0] === ethers.ZeroAddress && pa[1] === 0n && pu[0] === ethers.ZeroAddress && pu[1] === 0n);
  for (const n of PROXY_SLOT_NAMES) {
    check(`${n} empty on both proxies`, (await storage(token, ethers.keccak256(ethers.toUtf8Bytes(n)))) === 0n && (await storage(ctrl, ethers.keccak256(ethers.toUtf8Bytes(n)))) === 0n);
  }

  console.log("\nD. the quorum path on TVM");
  const rule = [[0n, MAX, [await view(ctrl, ctrlV3Iface, "OFFICER_ROLE"), await view(ctrl, ctrlV3Iface, "MANAGER_ROLE")]]];
  await must(ME, ctrl, ctrlV3Iface, "setQuorumRules", [0, rule], "setQuorumRules(Mint)");
  await must(ME, ctrl, ctrlV3Iface, "setQuorumRules", [1, rule], "setQuorumRules(Burn)");
  const op = async (type: number, to: string, amount: bigint, id: string, label?: string) => {
    const deadline = (await now()) + 3600n;
    const digest = await view(ctrl, ctrlV3Iface, "getOperationHash", [to, type, amount, id, deadline]);
    const sigs = [1, 2, 3, 4].map((i) => new ethers.SigningKey("0x" + pks[i]).sign(digest).serialized);
    return send(1, ctrl, ctrlV3Iface, "executeOperation", [type, to, amount, id, deadline, sigs], label);
  };
  const quorumRound = async (tag: string) => {
    const supply = BigInt(await view(token, tokenV3Iface, "totalSupply"));
    const m = await op(0, ethers.ZeroAddress, 10n ** 6n, `tre-${tag}-mint`, `executeOperation(Mint) ${tag}`);
    check(`Mint executes on TVM (${tag})`, m.ok && BigInt(await view(token, tokenV3Iface, "totalSupply")) === supply + 10n ** 6n, m.reason);
    const again = await op(0, ethers.ZeroAddress, 10n ** 6n, `tre-${tag}-mint`);
    check(`same identifier, new deadline: refused (${tag})`, !again.ok && again.reason.includes("Operation identifier already used"), again.reason);
    const b = await op(1, acct(DEPO), 10n ** 6n, `tre-${tag}-burn`, `executeOperation(Burn) ${tag}`);
    check(`Burn executes on TVM (${tag})`, b.ok && BigInt(await view(token, tokenV3Iface, "totalSupply")) === supply, b.reason);
  };
  await quorumRound("after-migration");

  console.log("\nE. handovers on TVM");
  await must(ME, token, tokenV3Iface, "beginAdminTransfer", [acct(NEW_ADMIN)], "beginAdminTransfer");
  const [, adminSchedule] = await view(token, tokenV3Iface, "pendingAdmin");
  const early = await send(NEW_ADMIN, token, tokenV3Iface, "acceptAdminTransfer", []);
  check("accept before the delay refused", !early.ok && early.reason.startsWith("TransferDelayNotPassed"), early.reason);
  await waitPast(BigInt(adminSchedule));
  const stranger = await send(STRANGER, token, tokenV3Iface, "acceptAdminTransfer", []);
  check("a stranger cannot accept", !stranger.ok && stranger.reason.startsWith("NotPendingAdmin"), stranger.reason);
  await must(NEW_ADMIN, token, tokenV3Iface, "acceptAdminTransfer", [], "acceptAdminTransfer");
  check("admin moved", (await view(token, tokenV3Iface, "admin")).toLowerCase() === acct(NEW_ADMIN));
  const oldAdmin = await send(ME, token, tokenV3Iface, "setMaxSupply", [1n]);
  check("old admin locked out", !oldAdmin.ok && oldAdmin.reason.startsWith("NotAdmin"), oldAdmin.reason);

  await must(NEW_ADMIN, token, tokenV3Iface, "beginAdminTransfer", [acct(STRANGER)]);
  await must(NEW_ADMIN, token, tokenV3Iface, "cancelAdminTransfer", [], "cancelAdminTransfer");
  const cleared = await view(token, tokenV3Iface, "pendingAdmin");
  check("cancel clears the pending admin", cleared[0] === ethers.ZeroAddress && cleared[1] === 0n);

  await must(NEW_ADMIN, token, tokenV3Iface, "beginUpgraderTransfer", [acct(NEW_UPGRADER)], "beginUpgraderTransfer");
  const [, upgraderSchedule] = await view(token, tokenV3Iface, "pendingUpgrader");
  await waitPast(BigInt(upgraderSchedule));
  await must(NEW_UPGRADER, token, tokenV3Iface, "acceptUpgraderTransfer", [], "acceptUpgraderTransfer");
  check("upgrader moved", (await view(token, tokenV3Iface, "upgrader")).toLowerCase() === acct(NEW_UPGRADER));
  const oldUpgrader = await send(ME, token, tokenV3Iface, "scheduleUpgrade", [hex20(tokenV3[1])]);
  check("old upgrader locked out", !oldUpgrader.ok && oldUpgrader.reason.startsWith("NotUpgrader"), oldUpgrader.reason);

  console.log("\nF. two more upgrades each — the token by its NEW upgrader");
  for (const hop of [1, 2]) {
    await must(NEW_UPGRADER, token, tokenV3Iface, "scheduleUpgrade", [hex20(tokenV3[hop])], `token scheduleUpgrade hop ${hop}`);
    await must(ME, ctrl, ctrlV3Iface, "scheduleUpgrade", [hex20(ctrlV3[hop])], `controller scheduleUpgrade hop ${hop}`);
    const at = [
      BigInt(await view(token, tokenV3Iface, "upgradeScheduledAt")),
      BigInt(await view(ctrl, ctrlV3Iface, "upgradeScheduledAt")),
    ].reduce((a, b) => (a > b ? a : b));
    await waitPast(at + delay + 3n);
    await must(NEW_UPGRADER, token, tokenV3Iface, "upgradeTo", [hex20(tokenV3[hop])], `token upgradeTo hop ${hop}`);
    await must(ME, ctrl, ctrlV3Iface, "upgradeTo", [hex20(ctrlV3[hop])], `controller upgradeTo hop ${hop}`);
    check(`hop ${hop}: token on v3 #${hop + 1}`, (await storage(token, IMPL_SLOT)) === BigInt(hex20(tokenV3[hop])));
    check(`hop ${hop}: controller on v3 #${hop + 1}`, (await storage(ctrl, IMPL_SLOT)) === BigInt(hex20(ctrlV3[hop])));
  }
  const end = await tokenSnap(tokenV3Iface);
  check("after every hop: balances, supply, freeze, permit domain", JSON.stringify(end, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(before, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  check("after every hop: controller signing domain", (await digestProbe(ctrlV3Iface)) === digestBefore);
  check("after every hop: quorum roles", (await rolesHeld(ctrlV3Iface)) === 4);
  check("after every hop: handover seats kept", (await view(token, tokenV3Iface, "admin")).toLowerCase() === acct(NEW_ADMIN) && (await view(token, tokenV3Iface, "upgrader")).toLowerCase() === acct(NEW_UPGRADER));
  for (const n of PROXY_SLOT_NAMES) {
    check(`after every hop: ${n} empty on both`, (await storage(token, ethers.keccak256(ethers.toUtf8Bytes(n)))) === 0n && (await storage(ctrl, ethers.keccak256(ethers.toUtf8Bytes(n)))) === 0n);
  }
  await quorumRound("after-all-hops");

  console.log("\nenergy (TVM):");
  for (const [k, v] of energy) console.log(`   ${k.padEnd(44)} ${String(v).padStart(10)}`);
  const failed = results.filter(([, p]) => !p);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    for (const [n, , d] of failed) console.log(`   ✗ ${n} ${d}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n✗", e.message || e); process.exit(1); });

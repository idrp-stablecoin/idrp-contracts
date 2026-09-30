import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import hre from "hardhat";
import { ethers } from "ethers";

/**
 * Deploys the `testnet` environment on Nile: fresh IDRP + IDRPController
 * proxies built from this tree (the source Tron mainnet runs) with both
 * timelocks cut to 5 minutes.
 *
 * Same features and logic as Tron mainnet; only the build differs. The two
 * UPGRADE_DELAY lines are edited to `5 minutes` for the compile and restored
 * straight after; nothing is committed. Only --network nile (and tre for a
 * local rehearsal) are accepted.
 *
 * It wires the contracts the way Tron mainnet is wired: depository, sanctions
 * list, MINTER/PAUSER/FREEZER on the controller and not on the deployer, the
 * quorum roles, and the quorum rules in test/utils/rules.*.json (identical to
 * Tron mainnet's, order included). The wallets are the ones Nile uses today.
 *
 * Records:
 *   deployment/testnet/tron/nile.json                   addresses, wiring, source commit
 *   deployment/builds/3448148188/<implementation>.json  exact compiler input per implementation
 *
 * Usage:
 *   npx hardhat run scripts/testnet-deploy-tron.ts --network nile
 *   npx hardhat run scripts/testnet-deploy-tron.ts --network tre     (local TVM, records to a temp dir)
 *
 * Env:
 *   MINT_IDRP        whole IDRP minted to the depository as test supply (default 1000000, 0 skips)
 *   SANCTIONS_LIST   sanctions list to wire (T-address). Otherwise Nile's list, or on tre a fresh one.
 */

const ENV = "testnet";
const DELAY_TEXT = "5 minutes";
const DELAY_SECONDS = 300n;
const NILE_CHAIN_ID = 3448148188;

/** Every timelock constant in this lineage; each is edited for the testnet build. */
const DELAY_LINES: Array<[string, string]> = [
  ["contracts/IDRP.sol", "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  ["contracts/IDRPController.sol", "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
];

/** The wallets Nile uses today (measured on the live Nile controller and token). */
const QUORUM_SIGNERS: Array<[string, string]> = [
  ["OFFICER_ROLE", "TRdtU12WDtT1FTEJik3tKBLv74BzthYfk8"],
  ["OFFICER_ROLE", "TXbC54RQ1SkwPLignMGT1nkhne9Z4nRyzG"],
  ["MANAGER_ROLE", "TQbWCxtHFYzMyCraqFsS7WxStHckfkcyGk"],
  ["DIRECTOR_ROLE", "TEcdkZu92pvMS6NcFZ2KUrqfDsXnRdMuHK"],
  ["COMMISSIONER_ROLE", "TRpY5VmtdsMqNW2tc6U2kvoknzDevM74NJ"],
];
const DEPOSITORY = "TQHZ6XmErRcTaBjoWnBwd55sKdoUDfuNn6";
const NILE_SANCTIONS_LIST = "TBCVynr5bAZWpiDt1WDCH8dWnkDUTdJqPp";

const RULE_FILES: Array<[number, string, string]> = [
  [0, "Mint", "rules.mint.burn.json"],
  [1, "Burn", "rules.mint.burn.json"],
  [2, "Freeze", "rules.freeze.unfreeze.json"],
  [3, "Unfreeze", "rules.freeze.unfreeze.json"],
  [4, "Pause", "rules.pause.json"],
  [5, "Unpause", "rules.unpause.json"],
];

const TOKEN_ROLES = ["MINTER_ROLE", "PAUSER_ROLE", "FREEZER_ROLE"];

const root = hre.config.paths.root;
const sh = (cmd: string) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
const TronWeb = require("tronweb");
let tw: any;
let host: string;
let me: string;

const hex20 = (t: string) => "0x" + tw.address.toHex(t).slice(2);

async function rpc(method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const body = await fetch(`${host}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json());
      if (body.result !== undefined) return body.result;
      last = body.error ?? body;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  // A failed read must never pass as a check.
  throw new Error(`${method} failed after retries: ${JSON.stringify(last)}`);
}

async function view(contract: string, signature: string, args: unknown[] = []): Promise<ethers.Result> {
  const ifc = new ethers.Interface([`function ${signature}`]);
  const fn = ifc.fragments[0] as ethers.FunctionFragment;
  const data = ifc.encodeFunctionData(fn, args);
  return ifc.decodeFunctionResult(fn, await rpc("eth_call", [{ to: hex20(contract), data }, "latest"]));
}

async function waitFor(txid: string, label: string) {
  for (let i = 0; i < 40; i++) {
    const info = await tw.trx.getTransactionInfo(txid);
    if (info && info.blockNumber) {
      if (info.receipt?.result && info.receipt.result !== "SUCCESS") {
        const reason = info.contractResult?.[0] ? Buffer.from(info.contractResult[0], "hex").toString().replace(/[^\x20-\x7e]/g, "") : "";
        throw new Error(`${label} failed: ${info.receipt.result} ${reason}`);
      }
      return info;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: no receipt for ${txid}`);
}

async function deploy(fqn: string, types: string[], values: unknown[], label: string): Promise<string> {
  const artifact = await hre.artifacts.readArtifact(fqn);
  const rawParameter = types.length ? ethers.AbiCoder.defaultAbiCoder().encode(types, values).slice(2) : undefined;
  const tx = await tw.transactionBuilder.createSmartContract(
    {
      abi: { entrys: artifact.abi },
      bytecode: artifact.bytecode.replace(/^0x/, ""),
      feeLimit: 1_000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 10_000_000,
      rawParameter,
      name: fqn.split(":").pop(),
    },
    tw.address.toHex(me)
  );
  const res = await tw.trx.sendRawTransaction(await tw.trx.sign(tx));
  if (!res.result) throw new Error(`${label} deploy rejected: ${JSON.stringify(res)}`);
  await waitFor(tx.txID, label);
  const addr = tw.address.fromHex(tx.contract_address);
  if ((await rpc("eth_getCode", [hex20(addr), "latest"])) === "0x") throw new Error(`${label}: no code at ${addr}`);
  return addr;
}

async function send(contract: string, signature: string, args: unknown[], label: string) {
  const ifc = new ethers.Interface([`function ${signature}`]);
  const fn = ifc.fragments[0] as ethers.FunctionFragment;
  const rawParameter = ifc.encodeFunctionData(fn, args).slice(10);
  const { transaction } = await tw.transactionBuilder.triggerSmartContract(
    tw.address.toHex(contract),
    fn.format("sighash"),
    { feeLimit: 500_000_000, callValue: 0, rawParameter },
    [],
    tw.address.toHex(me)
  );
  const res = await tw.trx.sendRawTransaction(await tw.trx.sign(transaction));
  if (!res.result) throw new Error(`${label} rejected: ${JSON.stringify(res)}`);
  await waitFor(transaction.txID, label);
}

function loadRules(file: string) {
  return JSON.parse(fs.readFileSync(path.join(root, "test/utils", file), "utf8")).map((r: any) => [
    BigInt(r.minAmount),
    BigInt(r.maxAmount),
    r.requiredRoles,
  ]);
}

/** The exact compiler input for one contract, trimmed to the files it was built from. */
async function buildRecord(fqn: string) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`no build info for ${fqn}`);
  const [source, name] = fqn.split(":");
  const metadata = JSON.parse((buildInfo.output.contracts[source][name] as any).metadata);
  const sources: Record<string, unknown> = {};
  for (const file of Object.keys(metadata.sources)) sources[file] = buildInfo.input.sources[file];
  return { contract: fqn, compiler: `tron-solc ${buildInfo.solcLongVersion}`, input: { ...buildInfo.input, sources } };
}

/** Proves the runtime code at `impl` is the artifact just built, immutables aside. */
async function assertDeployedIsBuilt(fqn: string, impl: string) {
  const [source, name] = fqn.split(":");
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  const artifact = await hre.artifacts.readArtifact(fqn);
  const immutables = Object.values(
    ((buildInfo!.output.contracts[source][name] as any).evm.deployedBytecode.immutableReferences ?? {}) as Record<
      string,
      { start: number; length: number }[]
    >
  ).flat();
  const deployed = Buffer.from((await rpc("eth_getCode", [hex20(impl), "latest"])).slice(2), "hex");
  const built = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
  const self = Buffer.from(hex20(impl).slice(2), "hex");
  if (deployed.length !== built.length) throw new Error(`${name}: deployed ${deployed.length}B != built ${built.length}B`);
  for (const { start, length } of immutables) {
    if (!deployed.subarray(start + length - 20, start + length).equals(self)) {
      throw new Error(`${name}: immutable at ${start} is not the implementation's own address`);
    }
    deployed.fill(0, start, start + length);
    built.fill(0, start, start + length);
  }
  if (!deployed.equals(built)) throw new Error(`${name}: deployed code is not the build`);
}

/** Compiles with both delays at 5 minutes, runs `fn`, then restores the sources and rebuilds. */
async function withTestnetDelays<T>(fn: () => Promise<T>): Promise<T> {
  const files = [...new Set(DELAY_LINES.map(([f]) => f))];
  const originals = new Map(files.map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]));
  const patched = new Map(originals);
  for (const [file, line] of DELAY_LINES) {
    const src = patched.get(file)!;
    if (src.split(line).length !== 2) {
      throw new Error(`${file}: expected exactly one "${line.trim()}" — refusing to patch a tree I don't recognise`);
    }
    patched.set(file, src.replace(line, line.replace("48 hours", DELAY_TEXT)));
  }
  try {
    for (const [file, src] of patched) fs.writeFileSync(path.join(root, file), src);
    console.log(`  build: ${DELAY_LINES.length} delay constants -> ${DELAY_TEXT}`);
    await hre.run("compile", { quiet: true });
    return await fn();
  } finally {
    for (const [file, src] of originals) {
      fs.writeFileSync(path.join(root, file), src);
      if (fs.readFileSync(path.join(root, file), "utf8") !== src) {
        throw new Error(`FAILED TO RESTORE ${file} — fix by hand before committing`);
      }
    }
    await hre.run("compile", { quiet: true });
    console.log("  sources restored to 48 hours, artifacts rebuilt");
  }
}

async function main() {
  const network = hre.network.name;
  if (network !== "nile" && network !== "tre") {
    throw new Error(`REFUSING: --network ${network}. This deploys the testnet env to nile (or tre locally) only.`);
  }
  const local = network === "tre";
  const cfg = hre.network.config as any;
  host = String(cfg.url).replace(/\/jsonrpc\/?$/, "");
  const chainId = Number(await rpc("eth_chainId", []));
  if (!local && chainId !== NILE_CHAIN_ID) throw new Error(`REFUSING: chainId ${chainId} is not Nile (${NILE_CHAIN_ID}).`);
  tw = new TronWeb({ fullHost: host, headers: cfg.httpHeaders ?? {}, privateKey: String(cfg.accounts[0]).replace(/^0x/, "") });
  me = tw.defaultAddress.base58;

  const recordDir = local ? fs.mkdtempSync(path.join(os.tmpdir(), "idrp-testnet-tron-")) : path.join(root, "deployment");
  const recordFile = path.join(recordDir, ENV, "tron", `${network}.json`);
  if (fs.existsSync(recordFile)) {
    throw new Error(`${path.relative(root, recordFile)} exists — ${ENV} is already deployed here. Refusing to deploy twice.`);
  }
  const commit = sh("git rev-parse HEAD");
  // Only the build inputs have to match the recorded commit; deployment records
  // and the upgrades plugin's manifests change as a side effect of deploying.
  if (!local && sh("git status --porcelain --untracked-files=no -- contracts hardhat.config.ts package.json package-lock.json") !== "") {
    throw new Error("contracts/, hardhat.config.ts or the lockfile have uncommitted changes — commit first, so the recorded commit is the real source");
  }
  const mintWhole = process.env.MINT_IDRP ?? "1000000";
  console.log(`network         ${network} (chainId ${chainId})${local ? " LOCAL REHEARSAL" : ""}`);
  console.log(`env             ${ENV}   source ${commit.slice(0, 7)}`);
  console.log(`deployer        ${me}`);
  console.log(`balance         ${(await tw.trx.getBalance(me)) / 1e6} TRX`);

  const built = await withTestnetDelays(async () => {
    console.log("\n[1/7] IDRP implementation + proxy");
    const tokenImpl = await deploy("contracts/IDRP.sol:IDRP", [], [], "IDRP impl");
    const tokenInit = new ethers.Interface(["function initialize(address)"]).encodeFunctionData("initialize", [hex20(me)]);
    const token = await deploy(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      ["address", "bytes"],
      [hex20(tokenImpl), tokenInit],
      "IDRP proxy"
    );
    console.log(`      proxy ${token}  impl ${tokenImpl}`);

    console.log("\n[2/7] IDRPController implementation + proxy");
    const ctrlImpl = await deploy("contracts/IDRPController.sol:IDRPController", [], [], "controller impl");
    const ctrlInit = new ethers.Interface(["function initialize(address,address)"]).encodeFunctionData("initialize", [
      hex20(token),
      hex20(me),
    ]);
    const controller = await deploy(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      ["address", "bytes"],
      [hex20(ctrlImpl), ctrlInit],
      "controller proxy"
    );
    console.log(`      proxy ${controller}  impl ${ctrlImpl}`);

    for (const [label, addr] of [["IDRP", token], ["IDRPController", controller]]) {
      const [delay] = await view(addr, "UPGRADE_DELAY() view returns (uint256)");
      if (delay !== DELAY_SECONDS) throw new Error(`${label}.UPGRADE_DELAY = ${delay}, expected ${DELAY_SECONDS}`);
    }
    await assertDeployedIsBuilt("contracts/IDRP.sol:IDRP", tokenImpl);
    await assertDeployedIsBuilt("contracts/IDRPController.sol:IDRPController", ctrlImpl);
    console.log(`      delays ${DELAY_SECONDS}s on both; deployed code == build`);

    const builds = {
      IDRP: await buildRecord("contracts/IDRP.sol:IDRP"),
      IDRPController: await buildRecord("contracts/IDRPController.sol:IDRPController"),
    };
    return { token, controller, tokenImpl, ctrlImpl, builds };
  });
  const { token, controller, tokenImpl, ctrlImpl, builds } = built;

  console.log("\n[3/7] Sanctions list");
  let sanctionsList = process.env.SANCTIONS_LIST ?? (local ? undefined : NILE_SANCTIONS_LIST);
  if (sanctionsList) {
    if ((await rpc("eth_getCode", [hex20(sanctionsList), "latest"])) === "0x") throw new Error(`no code at ${sanctionsList}`);
  } else {
    sanctionsList = await deploy("contracts/sanctions/SanctionsList.sol:SanctionsList", [], [], "SanctionsList");
    console.log("      deployed a SanctionsList owned by the deployer");
  }
  console.log(`      ${sanctionsList}`);

  console.log("\n[4/7] Wiring the token");
  await send(token, "setDepositoryWallet(address)", [hex20(DEPOSITORY)], "setDepositoryWallet");
  await send(token, "setSanctionsList(address)", [hex20(sanctionsList)], "setSanctionsList");
  for (const role of TOKEN_ROLES) {
    await send(token, "grantRole(bytes32,address)", [ethers.id(role), hex20(controller)], `grant ${role}`);
  }
  const [depo] = await view(token, "depositoryWallet() view returns (address)");
  const [list] = await view(token, "sanctionsList() view returns (address)");
  if (depo.toLowerCase() !== hex20(DEPOSITORY).toLowerCase()) throw new Error("depository did not stick");
  if (list.toLowerCase() !== hex20(sanctionsList).toLowerCase()) throw new Error("sanctions list did not stick");
  console.log(`      depository ${DEPOSITORY}; MINTER/PAUSER/FREEZER -> controller`);

  console.log("\n[5/7] Quorum roles");
  for (const [role, addr] of QUORUM_SIGNERS) {
    await send(controller, "grantRole(bytes32,address)", [ethers.id(role), hex20(addr)], `grant ${role}`);
    const [ok] = await view(controller, "hasRole(bytes32,address) view returns (bool)", [ethers.id(role), hex20(addr)]);
    if (!ok) throw new Error(`${role} not granted to ${addr}`);
    console.log(`      ${role.replace("_ROLE", "").padEnd(13)} ${addr}`);
  }

  console.log("\n[6/7] Quorum rules");
  for (const [op, name, file] of RULE_FILES) {
    const rules = loadRules(file);
    await send(controller, "setQuorumRules(uint8,(uint256,uint256,bytes32[])[])", [op, rules], `rules ${name}`);
    for (const [i, [min, max, roles]] of rules.entries()) {
      const [live] = await view(
        controller,
        "getQuorumRule(uint8,uint256) view returns ((uint256 minAmount,uint256 maxAmount,bytes32[] requiredRoles))",
        [op, min]
      );
      if (live.minAmount !== min || live.maxAmount !== max || [...live.requiredRoles].join() !== roles.join()) {
        throw new Error(`${name} tier ${i} reads back differently`);
      }
    }
    console.log(`      op ${op} ${name.padEnd(9)} ${rules.length} tier(s)`);
  }

  console.log("\n[7/7] Test supply, then drop the deployer's token roles (Tron mainnet's deployer holds none)");
  if (mintWhole !== "0") {
    await send(token, "mint(uint256)", [ethers.parseUnits(mintWhole, 6)], "mint");
  }
  for (const role of TOKEN_ROLES) {
    await send(token, "revokeRole(bytes32,address)", [ethers.id(role), hex20(me)], `revoke ${role}`);
    const [still] = await view(token, "hasRole(bytes32,address) view returns (bool)", [ethers.id(role), hex20(me)]);
    if (still) throw new Error(`deployer still holds ${role}`);
  }
  const [supply] = await view(token, "totalSupply() view returns (uint256)");
  console.log(`      totalSupply ${supply} (to the depository); deployer keeps DEFAULT_ADMIN only`);

  const buildFile = (impl: string) => path.join(recordDir, "builds", String(NILE_CHAIN_ID), `${impl}.json`);
  for (const [impl, record] of [[tokenImpl, builds.IDRP], [ctrlImpl, builds.IDRPController]] as const) {
    fs.mkdirSync(path.dirname(buildFile(impl)), { recursive: true });
    fs.writeFileSync(buildFile(impl), JSON.stringify(record, null, 2) + "\n");
  }
  const rel = (p: string) => (local ? p : path.relative(root, p));
  const record = {
    env: ENV,
    network,
    chainId,
    sourceCommit: commit,
    delays: { "IDRP.UPGRADE_DELAY": DELAY_TEXT, "IDRPController.UPGRADE_DELAY": DELAY_TEXT },
    deployer: me,
    deployedAt: new Date().toISOString(),
    IDRP: token,
    IDRPController: controller,
    IDRPImpl: tokenImpl,
    IDRPControllerImpl: ctrlImpl,
    IDRPBuild: rel(buildFile(tokenImpl)),
    IDRPControllerBuild: rel(buildFile(ctrlImpl)),
    depositoryWallet: DEPOSITORY,
    sanctionsList,
    quorumSigners: QUORUM_SIGNERS.map(([role, addr]) => ({ role, addr })),
  };
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");

  console.log("\n─────────────────────────────────────────────────────");
  console.log(`token       ${token}   impl ${tokenImpl}`);
  console.log(`controller  ${controller}   impl ${ctrlImpl}`);
  console.log(`record      ${rel(recordFile)}`);
  console.log(`\nPlatform AppSettings for Nile:`);
  console.log(`  idrpAddress${NILE_CHAIN_ID}        = ${token}`);
  console.log(`  controllerAddress${NILE_CHAIN_ID}  = ${controller}`);
  if (!local) console.log(`\nCommit the record: git add deployment/${ENV}/tron/nile.json deployment/builds/${NILE_CHAIN_ID}/`);
}

main().catch((e) => {
  console.error("\n" + (e.message ?? e));
  process.exitCode = 1;
});

import fs from "fs";
import path from "path";
import hre from "hardhat";
import { ethers } from "ethers";

/**
 * Prepares Tronscan verification of the testnet env on Nile from the compiler
 * input recorded at deploy time (deployment/builds/3448148188/), so what gets
 * verified is the 5-minute build that is on chain, not the 48h tree.
 *
 *   npx hardhat run scripts/verify-testnet-builds-tron.ts --network nile
 *
 * Tronscan verifies through its web form only (single-file source), so this
 * writes one flattened file per contract to flattened/testnet-nile/ and prints
 * what to enter in the form. Before writing anything it proves, with the same
 * tron-solc, that:
 *   1. the recorded input compiles to the on-chain code, metadata included;
 *   2. the flattened file compiles to the same executable code (its metadata
 *      differs by construction; Tronscan compares the code).
 */

const ENV = "testnet";
const NILE_CHAIN_ID = 3448148188;
const OUT_DIR = "flattened/testnet-nile";
const PROXY_FQN = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

type Build = { contract: string; compiler: string; input: any };

const root = hre.config.paths.root;
let host: string;

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
  throw new Error(`${method} failed after retries: ${JSON.stringify(last)}`);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function tronToHex(address: string): string {
  let n = 0n;
  for (const c of address) n = n * 58n + BigInt(B58.indexOf(c));
  return "0x" + n.toString(16).padStart(50, "0").slice(2, 42);
}

/** The tron-solc build hardhat-tron compiled with (same soljson file). */
function tronSolc(version: string) {
  const { tronSolcPath } = require("@layerzerolabs/hardhat-tron/dist/constants");
  const file = tronSolcPath(version);
  if (!fs.existsSync(file)) throw new Error(`tron-solc ${version} not found at ${file} — compile once with --network nile`);
  return require("solc/wrapper")(require(file));
}

function compile(solc: any, input: any, source: string, name: string) {
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(`${name}: ${errors[0].formattedMessage}`);
  const c = out.contracts[source][name];
  return {
    code: Buffer.from(c.evm.deployedBytecode.object, "hex"),
    immutables: Object.values((c.evm.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>).flat(),
  };
}

/** Runtime code minus the trailing CBOR blob, whose length is its last 2 bytes. */
function withoutMetadata(code: Buffer): Buffer {
  const len = code.readUInt16BE(code.length - 2);
  return len + 2 <= code.length ? code.subarray(0, code.length - len - 2) : code;
}

/** null when `built` is the code at `address`; otherwise why not. */
async function compare(address: string, built: ReturnType<typeof compile>, withMetadata: boolean) {
  const hex = tronToHex(address);
  const chain = Buffer.from((await rpc("eth_getCode", [hex, "latest"])).slice(2), "hex");
  const code = Buffer.from(built.code);
  const self = Buffer.from(hex.slice(2), "hex");
  for (const { start, length } of built.immutables) {
    if (!chain.subarray(start + length - 20, start + length).equals(self)) return `immutable at ${start} is not the contract's own address`;
    chain.fill(0, start, start + length);
    code.fill(0, start, start + length);
  }
  const [a, b] = withMetadata ? [chain, code] : [withoutMetadata(chain), withoutMetadata(code)];
  if (a.length !== b.length) return `length ${a.length} != ${b.length}`;
  return a.equals(b) ? null : "bytes differ";
}

/** One file from a Standard JSON Input: dependencies first, imports dropped, one SPDX and pragma. */
function flatten(input: any, target: string): string {
  const sources: Record<string, { content: string }> = input.sources;
  const importRe = /^\s*import\s+(?:[^'";]*\s+from\s+)?["']([^"']+)["']\s*;[^\n]*$/gm;
  const seen = new Set<string>();
  const parts: string[] = [];
  const visit = (unit: string) => {
    if (seen.has(unit)) return;
    seen.add(unit);
    const src = sources[unit]?.content;
    if (src === undefined) throw new Error(`${unit} is not in the recorded input`);
    for (const m of src.matchAll(importRe)) {
      const imp = m[1];
      visit(imp.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(unit), imp)) : imp);
    }
    const body = src
      .replace(importRe, "")
      .replace(/^\s*\/\/\s*SPDX-License-Identifier:[^\n]*\n/gm, "")
      .replace(/^\s*pragma solidity[^;]*;[^\n]*\n/gm, "");
    parts.push(`// File: ${unit}\n${body.trim()}\n`);
  };
  visit(target);
  const pragma = sources[target].content.match(/pragma solidity[^;]*;/)![0];
  return `// SPDX-License-Identifier: MIT\n${pragma}\n\n${parts.join("\n")}`;
}

async function main() {
  if (hre.network.name !== "nile") throw new Error("run with --network nile");
  host = String((hre.network.config as any).url).replace(/\/jsonrpc\/?$/, "");
  const record = JSON.parse(fs.readFileSync(path.join(root, "deployment", ENV, "tron", "nile.json"), "utf8"));
  const load = (p: string): Build => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

  // Proxies were not recorded: build them from the tree (they have no delay constant).
  await hre.run("compile", { quiet: true });
  const proxyInfo = (await hre.artifacts.getBuildInfo(PROXY_FQN))!;
  const [proxySource, proxyName] = PROXY_FQN.split(":");
  const proxyMeta = JSON.parse((proxyInfo.output.contracts[proxySource][proxyName] as any).metadata);
  const proxyBuild: Build = {
    contract: PROXY_FQN,
    compiler: `tron-solc ${proxyInfo.solcLongVersion}`,
    input: { ...proxyInfo.input, sources: Object.fromEntries(Object.keys(proxyMeta.sources).map((f) => [f, proxyInfo.input.sources[f]])) },
  };

  const initToken = new ethers.Interface(["function initialize(address)"]).encodeFunctionData("initialize", [tronToHex(record.deployer)]);
  const initCtrl = new ethers.Interface(["function initialize(address,address)"]).encodeFunctionData("initialize", [
    tronToHex(record.IDRP),
    tronToHex(record.deployer),
  ]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const targets = [
    { label: "IDRP implementation", address: record.IDRPImpl, build: load(record.IDRPBuild), args: "" },
    { label: "IDRPController implementation", address: record.IDRPControllerImpl, build: load(record.IDRPControllerBuild), args: "" },
    { label: "IDRP proxy", address: record.IDRP, build: proxyBuild, args: coder.encode(["address", "bytes"], [tronToHex(record.IDRPImpl), initToken]).slice(2) },
    { label: "IDRPController proxy", address: record.IDRPController, build: proxyBuild, args: coder.encode(["address", "bytes"], [tronToHex(record.IDRPControllerImpl), initCtrl]).slice(2) },
  ];

  fs.mkdirSync(path.join(root, OUT_DIR), { recursive: true });
  for (const t of targets) {
    const [source, name] = t.build.contract.split(":");
    const version = t.build.compiler.split(" ")[1].split("+")[0];
    const solc = tronSolc(version);

    const exact = await compare(t.address, compile(solc, t.build.input, source, name), true);
    if (exact) throw new Error(`${t.label} ${t.address}: the recorded input does not reproduce it (${exact})`);

    const flat = flatten(t.build.input, source);
    const flatInput = {
      language: "Solidity",
      sources: { [`${name}.sol`]: { content: flat } },
      settings: {
        optimizer: t.build.input.settings.optimizer,
        evmVersion: t.build.input.settings.evmVersion,
        outputSelection: { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
      },
    };
    const flatCheck = await compare(t.address, compile(solc, flatInput, `${name}.sol`, name), false);
    if (flatCheck) throw new Error(`${t.label} ${t.address}: the flattened file does not reproduce it (${flatCheck})`);

    const file = path.join(OUT_DIR, `${name}_${t.address}.sol`);
    fs.writeFileSync(path.join(root, file), flat);
    const { enabled, runs } = t.build.input.settings.optimizer;
    console.log(`✓ ${t.label} ${t.address}`);
    console.log(`    form      https://nile.tronscan.org/#/contract/${t.address}/code  -> Verify and Publish`);
    console.log(`    file      ${file}   (main contract: ${name})`);
    console.log(`    compiler  ${t.build.compiler.split(" ")[1].replace(/\.Emscripten.*$/, "")}   optimizer ${enabled ? "yes" : "no"}, runs ${runs}   evm ${t.build.input.settings.evmVersion ?? "default"}   license MIT`);
    if (t.args) console.log(`    constructor args (if asked)  ${t.args}`);
  }
  console.log(`\nAll ${targets.length} files reproduce the on-chain code with tron-solc. Chain id ${NILE_CHAIN_ID}.`);
}

main().catch((e) => {
  console.error("\n" + (e.message ?? e));
  process.exitCode = 1;
});

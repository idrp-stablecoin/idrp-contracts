/**
 * Prepare Tronscan verification for every implementation the upgrade scripts deployed on
 * this network — from the compiler input recorded at deploy time, so what gets verified is
 * exactly the build on chain. Read-only on chain; writes files under flattened/<network>/.
 *
 *   npx hardhat run scripts/tron-explorer-files.ts --network tron   (or nile)
 *
 * Run it after each deploy and verify on Tronscan BEFORE the upgrade is executed, while
 * the timelock runs: if verification fails you can still cancel the schedule.
 *
 * Tronscan verifies through its web form only (single-file source, behind a captcha), so
 * this writes one flattened file per implementation and prints what to enter. Before
 * writing anything it proves, with the same tron-solc, that:
 *   1. the recorded input compiles to the on-chain code, metadata included;
 *   2. the flattened file compiles to the same executable code (its metadata differs by
 *      construction; Tronscan compares the code).
 */
import fs from "fs";
import path from "path";
import hre from "hardhat";
import { tronNetwork, hexOf, type TronNet } from "./utils/tron-network";
import { getCode } from "./utils/tron-preflight";

type Build = { contract: string; compiler: string; input: any };

/** The tron-solc build hardhat-tron compiles with (the same soljson file). */
function tronSolc(version: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tronSolcPath } = require("@layerzerolabs/hardhat-tron/dist/constants");
  const file = tronSolcPath(version);
  if (!fs.existsSync(file)) throw new Error(`tron-solc ${version} not found at ${file} — compile once with a Tron network`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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
async function compare(net: TronNet, address: string, built: ReturnType<typeof compile>, withMetadata: boolean) {
  const hex = hexOf(net, address);
  const chain = Buffer.from((await getCode(net, hex)).slice(2), "hex");
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
  const net = await tronNetwork(hre);
  if (net.name === "tre") throw new Error("a local TVM has no explorer");
  const root = hre.config.paths.root;
  const explorer = net.isMainnet ? "https://tronscan.org" : "https://nile.tronscan.org";
  const deployed = (net.record.upgrades ?? []).filter((u: any) => u.step === "deploy");
  if (!deployed.length) {
    console.log(`No deployed implementations recorded in ${path.relative(root, net.recordPath)} yet.`);
    return;
  }
  const outDir = path.join(root, "flattened", net.name);
  fs.mkdirSync(outDir, { recursive: true });
  for (const u of deployed) {
    const build: Build = JSON.parse(fs.readFileSync(path.join(root, u.build), "utf8"));
    const [source, name] = build.contract.split(":");
    const version = build.compiler.split(" ")[1].split("+")[0];
    const solc = tronSolc(version);

    const exact = await compare(net, u.implementation, compile(solc, build.input, source, name), true);
    if (exact) throw new Error(`${name} ${u.implementation}: the recorded input does not reproduce it (${exact})`);

    const flat = flatten(build.input, source);
    const flatInput = {
      language: "Solidity",
      sources: { [`${name}.sol`]: { content: flat } },
      settings: {
        optimizer: build.input.settings.optimizer,
        evmVersion: build.input.settings.evmVersion,
        outputSelection: { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
      },
    };
    const flatCheck = await compare(net, u.implementation, compile(solc, flatInput, `${name}.sol`, name), false);
    if (flatCheck) throw new Error(`${name} ${u.implementation}: the flattened file does not reproduce it (${flatCheck})`);

    const file = path.join(outDir, `${name}_${u.implementation}.sol`);
    fs.writeFileSync(file, flat);
    const { enabled, runs } = build.input.settings.optimizer;
    console.log(`✓ ${name} implementation ${u.implementation}  (${u.delays} build, source ${String(u.sourceCommit).slice(0, 7)})`);
    console.log(`    form      ${explorer}/#/contract/${u.implementation}/code  -> Verify and Publish`);
    console.log(`    file      ${path.relative(root, file)}   (main contract: ${name})`);
    console.log(`    compiler  ${build.compiler.split(" ")[1].replace(/\.Emscripten.*$/, "")}   optimizer ${enabled ? "yes" : "no"}, runs ${runs}   license MIT`);
  }
  console.log(`\nEvery file reproduces the on-chain code with tron-solc. Verify each on ${explorer} before executing its upgrade.`);
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

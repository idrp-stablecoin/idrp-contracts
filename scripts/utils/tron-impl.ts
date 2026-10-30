/**
 * Implementation checks shared by the Tron deploy / schedule / execute scripts.
 *
 * An implementation is only scheduled or executed when it reads, on chain, as the
 * build this network takes:
 *   - it has code, and proxiableUUID() is the ERC-1967 slot (a UUPS implementation);
 *   - every timelock constant equals this network's delay (48 h mainnet, 5 min testnet);
 *   - initializeV3 exists and its initializer is locked the OpenZeppelin 4 way.
 * The last one rejects exactly what was scheduled in June 2026: an OpenZeppelin 5 build,
 * whose locked initializer reverts with a custom error instead of the OZ 4 string.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "ethers";
import type { TronNet } from "./tron-network";
import { hexOf, recordUpgradeEvent } from "./tron-network";
import { ethCall, gatedSend, getCode, simulate } from "./tron-preflight";

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const OZ4_LOCKED_INITIALIZER = "Initializable: contract is already initialized";

export type Kind = "controller" | "token";

export const KINDS: Record<Kind, { fqn: string; name: string; delays: string[]; initializeV3: string }> = {
  controller: {
    fqn: "contracts/IDRPController.sol:IDRPController",
    name: "IDRPController",
    delays: ["UPGRADE_DELAY", "DEFAULT_ADMIN_DELAY"],
    initializeV3: "initializeV3(address,address,address[])",
  },
  token: {
    fqn: "contracts/IDRP.sol:IDRP",
    name: "IDRP",
    delays: ["UPGRADE_DELAY", "AUTHORITY_TRANSFER_DELAY"],
    initializeV3: "initializeV3(address,address,address)",
  },
};

const sh = (root: string, cmd: string) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();

/** The recorded commit must be the real source of what gets built. */
export function assertBuildInputsCommitted(hre: HardhatRuntimeEnvironment) {
  const root = hre.config.paths.root;
  const dirty = sh(root, "git status --porcelain --untracked-files=no -- contracts hardhat.config.ts package.json package-lock.json");
  if (dirty) {
    throw new Error(`contracts/, hardhat.config.ts, package.json or the lockfile have uncommitted changes — commit first, so the recorded commit is the real source:\n${dirty}`);
  }
  return sh(root, "git rev-parse HEAD");
}

/** The artifact must come from tron-solc, and its delay constants must read `delayText`. */
export async function assertArtifactIsBuild(hre: HardhatRuntimeEnvironment, kind: Kind, delayText: string) {
  const { fqn, delays } = KINDS[kind];
  const info = await hre.artifacts.getBuildInfo(fqn);
  if (!info) throw new Error(`no build info for ${fqn} — compile with the Tron network first`);
  if (!/^0\.8\.22\+.*Emscripten/.test(info.solcLongVersion)) {
    throw new Error(`${fqn} was compiled by ${info.solcLongVersion}, not tron-solc 0.8.22`);
  }
  const [source] = fqn.split(":");
  const text: string = info.input.sources[source]?.content ?? "";
  const found = new Map<string, string>();
  for (const m of text.matchAll(/constant\s+(UPGRADE_DELAY|DEFAULT_ADMIN_DELAY|AUTHORITY_TRANSFER_DELAY)\s*=\s*([^;]+);/g)) {
    if (found.has(m[1])) throw new Error(`${source}: ${m[1]} declared twice`);
    found.set(m[1], m[2].trim());
  }
  for (const d of delays) {
    if (found.get(d) !== delayText) throw new Error(`${source}: ${d} = ${found.get(d) ?? "(missing)"}, this network takes ${delayText}`);
  }
  for (const d of found.keys()) if (!delays.includes(d)) throw new Error(`${source}: unexpected timelock constant ${d}`);
  const artifact = await hre.artifacts.readArtifact(fqn);
  if (!artifact.abi.some((f: any) => f.type === "function" && f.name === "initializeV3")) {
    throw new Error(`${fqn} has no initializeV3 — this tree is not v3 (is it the v2 pin?)`);
  }
  return { info, artifact };
}

/** The exact compiler input for one contract, trimmed to the files it was built from. */
export async function buildRecord(hre: HardhatRuntimeEnvironment, fqn: string) {
  const info = await hre.artifacts.getBuildInfo(fqn);
  if (!info) throw new Error(`no build info for ${fqn}`);
  const [source, name] = fqn.split(":");
  const metadata = JSON.parse((info.output.contracts[source][name] as any).metadata);
  const sources: Record<string, unknown> = {};
  for (const file of Object.keys(metadata.sources)) sources[file] = info.input.sources[file];
  return { contract: fqn, compiler: `tron-solc ${info.solcLongVersion}`, input: { ...info.input, sources } };
}

/** Proves the runtime code at `impl` is the artifact just built, immutables (its own address) aside. */
export async function assertDeployedIsBuilt(hre: HardhatRuntimeEnvironment, net: TronNet, fqn: string, impl: string) {
  const [source, name] = fqn.split(":");
  const info = await hre.artifacts.getBuildInfo(fqn);
  const artifact = await hre.artifacts.readArtifact(fqn);
  const immutables = Object.values(
    ((info!.output.contracts[source][name] as any).evm.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>,
  ).flat();
  const implHex = hexOf(net, impl);
  const deployed = Buffer.from((await getCode(net, implHex)).slice(2), "hex");
  const built = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
  const self = Buffer.from(implHex.slice(2), "hex");
  if (deployed.length !== built.length) throw new Error(`${name}: deployed ${deployed.length} B != built ${built.length} B`);
  for (const { start, length } of immutables) {
    if (!deployed.subarray(start + length - 20, start + length).equals(self)) {
      throw new Error(`${name}: immutable at ${start} is not the implementation's own address`);
    }
    deployed.fill(0, start, start + length);
    built.fill(0, start, start + length);
  }
  if (!deployed.equals(built)) throw new Error(`${name}: deployed code is not the build`);
}

const word = (v: string | null) => (v && v !== "0x" ? BigInt(v) : null);

/** Reads `impl` on chain and throws unless it is the v3 build this network takes. Returns what it checked. */
export async function checkImplementation(net: TronNet, impl: string, kind: Kind): Promise<string[]> {
  const implHex = hexOf(net, impl);
  const lines: string[] = [];
  const code = await getCode(net, implHex);
  if (!code || code === "0x") throw new Error(`no code at ${impl}`);
  lines.push(`code            ${(code.length - 2) / 2} B`);

  const sel = (sig: string) => ethers.id(sig).slice(0, 10);
  const uuid = await ethCall(net, implHex, sel("proxiableUUID()"));
  if (uuid?.toLowerCase() !== IMPL_SLOT) throw new Error(`${impl}: proxiableUUID() = ${uuid}, not the ERC-1967 slot`);
  lines.push(`proxiableUUID   ERC-1967 implementation slot ✓`);

  for (const d of KINDS[kind].delays) {
    const v = word(await ethCall(net, implHex, sel(`${d}()`)));
    if (v !== BigInt(net.delaySeconds)) throw new Error(`${impl}: ${d}() = ${v}, this network takes ${net.delaySeconds} s`);
    lines.push(`${d.padEnd(15)} ${v} s ✓`);
  }

  const sig = KINDS[kind].initializeV3;
  const frag = ethers.FunctionFragment.from(`function ${sig}`);
  const dummy = "0x000000000000000000000000000000000000dEaD";
  const args = frag.inputs.map((i) => (i.type === "address[]" ? [dummy] : dummy));
  const parameter = ethers.AbiCoder.defaultAbiCoder().encode(frag.inputs, args).slice(2);
  const sim = await simulate(net, { owner: net.signer, contract: net.tw.address.fromHex("41" + implHex.slice(2)), selector: sig, parameter });
  if (sim.ok) throw new Error(`${impl}: initializeV3 did not revert on the bare implementation — its initializer is not locked`);
  if (sim.reason !== OZ4_LOCKED_INITIALIZER) {
    throw new Error(`${impl}: initializeV3 reverted with "${sim.reason}", not the OpenZeppelin 4 locked-initializer message — wrong build (OZ 5?)`);
  }
  lines.push(`initializeV3    present, locked the OZ 4 way ✓`);
  return lines;
}

/**
 * Deploys the compiled `kind` implementation through the funding gate, then proves the
 * code on chain is the build, records the compiler input and the deploy, and checks the
 * implementation as checkImplementation does. Returns the base58 address, or undefined
 * on a dry run. The caller compiles (and, on a testnet, edits the delays) beforehand.
 */
export async function deployImplementation(
  hre: HardhatRuntimeEnvironment,
  net: TronNet,
  kind: Kind,
  sourceCommit: string,
): Promise<string | undefined> {
  const { fqn, name } = KINDS[kind];
  const { artifact } = await assertArtifactIsBuild(hre, kind, net.delayText);
  const sim = await simulate(net, { owner: net.signer, data: artifact.bytecode });
  if (!sim.ok) throw new Error(`deploying ${name} would fail: ${sim.reason}`);

  let txContract = "";
  const info = await gatedSend(net, {
    label: `deploy the ${name} v3 implementation (${net.delayText} build, source ${sourceCommit.slice(0, 7)})`,
    energy: sim.energy,
    build: async (feeLimit) => {
      const tx = await net.tw.transactionBuilder.createSmartContract(
        {
          abi: { entrys: artifact.abi },
          bytecode: artifact.bytecode.replace(/^0x/, ""),
          feeLimit,
          callValue: 0,
          userFeePercentage: 100,
          originEnergyLimit: 10_000_000,
          name,
        },
        net.tw.address.toHex(net.signer),
      );
      txContract = tx.contract_address;
      return tx;
    },
  });
  if (!info) return undefined;

  const impl: string = net.tw.address.fromHex(info.contract_address ?? txContract);
  await assertDeployedIsBuilt(hre, net, fqn, impl);
  console.log(`\n  implementation ${impl}  (deployed code == the build ✓)`);
  for (const l of await checkImplementation(net, impl, kind)) console.log(`  ${l}`);

  fs.mkdirSync(net.buildsDir, { recursive: true });
  const buildFile = path.join(net.buildsDir, `${impl}.json`);
  fs.writeFileSync(buildFile, JSON.stringify(await buildRecord(hre, fqn), null, 2) + "\n");
  const root = hre.config.paths.root;
  const rel = (p: string) => (p.startsWith(root + path.sep) ? path.relative(root, p) : p);
  recordUpgradeEvent(net, {
    step: "deploy",
    contract: name,
    implementation: impl,
    build: rel(buildFile),
    sourceCommit,
    delays: net.delayText,
    tx: info.id,
  });
  console.log(`  recorded       ${rel(buildFile)}\n                 ${rel(net.recordPath)} (upgrades[])`);
  return impl;
}

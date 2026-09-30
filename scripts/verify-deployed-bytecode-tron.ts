// Proves the IDRP / IDRPController source in this tree is what runs on Tron
// mainnet: the executable code is identical byte for byte.
//
// Reads each live implementation from the proxy's ERC-1967 slot and compares
// its runtime code with the tron-solc artifact. The only bytes allowed to
// differ are the compiler's immutableReferences (UUPS `__self`), and each of
// those must hold the implementation's own address.
//
// The trailing CBOR metadata is compared and reported but not required to
// match: it fingerprints the exact source text and compiler invocation of the
// original build, which this tree does not reproduce.
//
//   npx hardhat run scripts/verify-deployed-bytecode-tron.ts --network tron
//
// Exits non-zero on any mismatch or failed read. Read-only: no transactions.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import hre from "hardhat";

const JSONRPC = "https://api.trongrid.io/jsonrpc";
const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CONTRACTS = [
  { key: "IDRP", fqn: "contracts/IDRP.sol:IDRP" },
  { key: "IDRPController", fqn: "contracts/IDRPController.sol:IDRPController" },
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Base58check T-address -> 0x-prefixed 20-byte hex, checksum enforced.
function tronToHex(address: string): string {
  let n = 0n;
  for (const c of address) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58 in ${address}`);
    n = n * 58n + BigInt(i);
  }
  const raw = Buffer.from(n.toString(16).padStart(50, "0"), "hex");
  const payload = raw.subarray(0, 21);
  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest();
  if (payload[0] !== 0x41 || !sha(sha(payload)).subarray(0, 4).equals(raw.subarray(21))) {
    throw new Error(`${address} is not a valid Tron address`);
  }
  return "0x" + payload.subarray(1).toString("hex");
}

async function rpc(method: string, params: unknown[]): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(JSONRPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (typeof body.result === "string") return body.result;
      last = body.error ?? body;
    } catch (e) {
      last = e;
    }
    // TronGrid rate-limits the public quota.
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  // A failed read must never pass as a match.
  throw new Error(`${method} failed after retries: ${JSON.stringify(last)}`);
}

// Runtime code minus the trailing CBOR blob, whose length is its last 2 bytes.
function withoutMetadata(code: Buffer): Buffer {
  if (code.length < 2) return code;
  const len = code.readUInt16BE(code.length - 2);
  return len + 2 <= code.length ? code.subarray(0, code.length - len - 2) : code;
}

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error("run with --network tron: mainnet was built with tron-solc, not solc");
  }
  await hre.run("compile", { quiet: true });

  const compiled = new Map<string, { code: Buffer; immutables: { start: number; length: number }[] }>();
  for (const { key, fqn } of CONTRACTS) {
    const artifact = await hre.artifacts.readArtifact(fqn);
    const buildInfo = await hre.artifacts.getBuildInfo(fqn);
    if (!buildInfo) throw new Error(`no build info for ${fqn}`);
    const [source, name] = fqn.split(":");
    const out = buildInfo.output.contracts[source][name] as any;
    const immutables = Object.values(
      (out.evm.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>
    ).flat();
    compiled.set(key, { code: Buffer.from(artifact.deployedBytecode.slice(2), "hex"), immutables });
    if (key === "IDRP") {
      console.log(`solc ${buildInfo.solcLongVersion}, ${JSON.stringify(buildInfo.input.settings.optimizer)}, evm ${buildInfo.input.settings.evmVersion}`);
    }
  }

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../deployment/tron/mainnet.json"), "utf-8")
  );
  const block = parseInt(await rpc("eth_blockNumber", []), 16);

  let failures = 0;
  for (const { key } of CONTRACTS) {
    const proxy: string = deployment[key];
    const word = await rpc("eth_getStorageAt", [tronToHex(proxy), IMPL_SLOT, "latest"]);
    const impl = "0x" + word.slice(-40);
    const deployedFull = Buffer.from((await rpc("eth_getCode", [impl, "latest"])).slice(2), "hex");
    const compiledFull = compiled.get(key)!;
    const deployed = withoutMetadata(deployedFull);
    const code = withoutMetadata(compiledFull.code);
    const { immutables } = compiledFull;
    const metadata = deployedFull.subarray(deployed.length).equals(compiledFull.code.subarray(code.length))
      ? "metadata identical"
      : "metadata differs";
    const self = Buffer.from(impl.slice(2), "hex");

    const problems: string[] = [];
    if (deployed.length === 0) problems.push("no code at the implementation");
    if (deployed.length !== code.length) problems.push(`length ${deployed.length} != ${code.length}`);

    // Blank every immutable slot on both sides, after checking the deployed
    // one holds the implementation's own address.
    const a = Buffer.from(deployed);
    const b = Buffer.from(code);
    for (const { start, length } of immutables) {
      if (!deployed.subarray(start + length - 20, start + length).equals(self)) {
        problems.push(`immutable at ${start} is not the implementation's address`);
      }
      a.fill(0, start, start + length);
      b.fill(0, start, start + length);
    }
    if (problems.length === 0 && !a.equals(b)) {
      let i = 0;
      while (a[i] === b[i]) i++;
      problems.push(`first differing byte at ${i}`);
    }

    const verdict = problems.length === 0 ? `EXACT (${metadata})` : `MISMATCH (${problems.join("; ")})`;
    if (problems.length) failures++;
    console.log(`tron @${block} ${key.padEnd(14)} proxy ${proxy} impl ${impl} ${deployedFull.length}B ${verdict}`);
  }

  if (failures) {
    console.error(`\n${failures} mismatch(es): this tree is NOT what is deployed.`);
    process.exitCode = 1;
  } else {
    console.log("\nBoth deployed implementations match this tree's executable code exactly.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

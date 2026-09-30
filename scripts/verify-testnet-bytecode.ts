// Proves the IDRP / IDRPController source in this tree is what runs on the EVM
// testnets (Base Sepolia, Kairos), once the testnet build's delays are applied:
// IDRP UPGRADE_DELAY = 300 seconds, IDRPController UPGRADE_DELAY and
// DEFAULT_ADMIN_DELAY = 5 minutes. Those are the exact edits the testnet builds
// were made with, so the CBOR metadata hash is reproduced as well.
//
// The sources are patched in place for one compile, then restored and rebuilt.
// It refuses to run if the canonical 48h lines are not where it expects them.
//
//   npx hardhat run scripts/verify-testnet-bytecode.ts
//
// Read-only on chain. Exits non-zero on any mismatch or failed read.
import fs from "fs";
import path from "path";
import hre from "hardhat";

const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CHAINS: { name: string; chainId: number; rpcs: string[] }[] = [
  { name: "base-sepolia", chainId: 84532, rpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] },
  { name: "kairos", chainId: 1001, rpcs: ["https://public-en-kairos.node.kaia.io"] },
];

// deployment JSON key -> contract; the *Previous proxies run the same build.
const PROXIES: { key: string; contract: "IDRP" | "IDRPController" }[] = [
  { key: "IDRP", contract: "IDRP" },
  { key: "IDRPController", contract: "IDRPController" },
  { key: "IDRPPrevious", contract: "IDRP" },
  { key: "IDRPControllerPrevious", contract: "IDRPController" },
];

const PATCHES: { file: string; from: string; to: string }[] = [
  {
    file: "contracts/IDRP.sol",
    from: "    uint256 public constant UPGRADE_DELAY = 48 hours;",
    to: "    uint256 public constant UPGRADE_DELAY = 300 seconds;",
  },
  {
    file: "contracts/IDRPController.sol",
    from: "    uint256 public constant UPGRADE_DELAY = 48 hours;",
    to: "    uint256 public constant UPGRADE_DELAY = 5 minutes;",
  },
  {
    file: "contracts/IDRPController.sol",
    from: "    uint48 public constant DEFAULT_ADMIN_DELAY = 48 hours;",
    to: "    uint48 public constant DEFAULT_ADMIN_DELAY = 5 minutes;",
  },
];

type Build = { code: Buffer; immutables: { start: number; length: number }[] };

async function rpc(urls: string[], method: string, params: unknown[]): Promise<string> {
  let last: unknown;
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body = await res.json();
        if (body.error) throw new Error(JSON.stringify(body.error));
        return body.result;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  // A failed read must never pass as a match.
  throw new Error(`${method} failed on every RPC: ${last}`);
}

// Runtime code minus the trailing CBOR blob, whose length is its last 2 bytes.
function withoutMetadata(code: Buffer): Buffer {
  if (code.length < 2) return code;
  const len = code.readUInt16BE(code.length - 2);
  return len + 2 <= code.length ? code.subarray(0, code.length - len - 2) : code;
}

async function readBuild(name: string): Promise<Build> {
  const fqn = `contracts/${name}.sol:${name}`;
  const artifact = await hre.artifacts.readArtifact(fqn);
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`no build info for ${fqn}`);
  const out = buildInfo.output.contracts[`contracts/${name}.sol`][name] as any;
  const immutables = Object.values(
    (out.evm.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>
  ).flat();
  return { code: Buffer.from(artifact.deployedBytecode.slice(2), "hex"), immutables };
}

async function buildTestnetVariant(): Promise<Record<string, Build>> {
  const originals = new Map<string, string>();
  for (const p of PATCHES) {
    const file = path.join(__dirname, "..", p.file);
    const src = originals.get(file) ?? fs.readFileSync(file, "utf-8");
    originals.set(file, src);
  }
  const patched = new Map(originals);
  for (const p of PATCHES) {
    const file = path.join(__dirname, "..", p.file);
    const src = patched.get(file)!;
    if (src.split(p.from).length !== 2) {
      throw new Error(`${p.file}: expected exactly one canonical line\n  ${p.from.trim()}\nRefusing to patch.`);
    }
    patched.set(file, src.replace(p.from, p.to));
  }
  try {
    for (const [file, src] of patched) fs.writeFileSync(file, src);
    await hre.run("compile", { quiet: true });
    return { IDRP: await readBuild("IDRP"), IDRPController: await readBuild("IDRPController") };
  } finally {
    for (const [file, src] of originals) fs.writeFileSync(file, src);
    for (const [file, src] of originals) {
      if (fs.readFileSync(file, "utf-8") !== src) throw new Error(`FAILED TO RESTORE ${file}`);
    }
    // Leave artifacts matching the committed sources, never the testnet build.
    await hre.run("compile", { quiet: true });
  }
}

async function main() {
  const builds = await buildTestnetVariant();

  let failures = 0;
  for (const chain of CHAINS) {
    const deployment = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../deployment/chain-${chain.chainId}.json`), "utf-8")
    );
    const block = parseInt(await rpc(chain.rpcs, "eth_blockNumber", []), 16);

    for (const { key, contract } of PROXIES) {
      const proxy: string | undefined = deployment[key];
      if (!proxy) continue;
      const word = await rpc(chain.rpcs, "eth_getStorageAt", [proxy, IMPL_SLOT, "latest"]);
      const impl = "0x" + word.slice(-40);
      const deployed = Buffer.from((await rpc(chain.rpcs, "eth_getCode", [impl, "latest"])).slice(2), "hex");
      const { code, immutables } = builds[contract];
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

      let verdict: string;
      if (problems.length === 0 && a.equals(b)) {
        verdict = "EXACT (metadata included)";
      } else if (problems.length === 0 && withoutMetadata(a).equals(withoutMetadata(b))) {
        verdict = "EXACT executable (metadata differs)";
      } else {
        if (problems.length === 0) {
          let i = 0;
          while (a[i] === b[i]) i++;
          problems.push(`first differing byte at ${i}`);
        }
        verdict = `MISMATCH (${problems.join("; ")})`;
        failures++;
      }
      console.log(`${chain.name.padEnd(12)} @${block} ${key.padEnd(22)} proxy ${proxy} impl ${impl} ${deployed.length}B ${verdict}`);
    }
  }

  if (failures) {
    console.error(`\n${failures} mismatch(es): this tree is NOT what the testnets run.`);
    process.exitCode = 1;
  } else {
    console.log("\nEvery testnet implementation matches this tree's testnet build.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// Proves the IDRP / IDRPController source in this tree is what runs on the
// EVM mainnets, byte for byte, INCLUDING the CBOR metadata hash.
//
// For each chain it reads the live implementation from the proxy's ERC-1967
// slot and compares its runtime code with the compiled artifact. The only bytes
// allowed to differ are the compiler's immutableReferences (UUPS `__self`),
// and each of those must hold the implementation's own address.
//
//   npx hardhat run scripts/verify-deployed-bytecode.ts
//
// Exits non-zero on any mismatch or failed read. Read-only: no transactions.
import fs from "fs";
import path from "path";
import hre from "hardhat";

const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CHAINS: { name: string; chainId: number; rpcs: string[] }[] = [
  { name: "ethereum", chainId: 1, rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] },
  { name: "polygon", chainId: 137, rpcs: ["https://polygon.drpc.org", "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"] },
  { name: "bsc", chainId: 56, rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"] },
  { name: "kaia", chainId: 8217, rpcs: ["https://public-en.node.kaia.io"] },
];

const CONTRACTS = [
  { key: "IDRP", fqn: "contracts/IDRP.sol:IDRP" },
  { key: "IDRPController", fqn: "contracts/IDRPController.sol:IDRPController" },
];

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

async function main() {
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

  let failures = 0;
  for (const chain of CHAINS) {
    const deployment = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../deployment/chain-${chain.chainId}.json`), "utf-8")
    );
    const block = parseInt(await rpc(chain.rpcs, "eth_blockNumber", []), 16);

    for (const { key } of CONTRACTS) {
      const proxy: string = deployment[key];
      const word = await rpc(chain.rpcs, "eth_getStorageAt", [proxy, IMPL_SLOT, "latest"]);
      const impl = "0x" + word.slice(-40);
      const deployed = Buffer.from((await rpc(chain.rpcs, "eth_getCode", [impl, "latest"])).slice(2), "hex");
      const { code, immutables } = compiled.get(key)!;
      const self = Buffer.from(impl.slice(2), "hex");

      const problems: string[] = [];
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

      const verdict = problems.length === 0 ? "EXACT" : `MISMATCH (${problems.join("; ")})`;
      if (problems.length) failures++;
      console.log(`${chain.name.padEnd(8)} @${block} ${key.padEnd(14)} proxy ${proxy} impl ${impl} ${deployed.length}B ${verdict}`);
    }
  }

  if (failures) {
    console.error(`\n${failures} mismatch(es): this tree is NOT what is deployed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll deployed implementations match this tree exactly (CBOR metadata included).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Prove which repo source is running behind the live Tron mainnet proxies.
 *
 *   npx hardhat run scripts/verify-deployed-source.ts --network tron
 *
 * Read-only. Touches nothing on chain.
 *
 * HOW TO COMPARE BYTECODE CORRECTLY — three traps, all of which we hit once:
 *
 *   1. Resolve the proxy to its implementation first. `wallet/getcontract` on a
 *      proxy address returns the ERC1967Proxy, not the logic contract. Read the
 *      ERC-1967 slot and fetch THAT address.
 *
 *   2. Compare like with like. `wallet/getcontract`.bytecode is CREATION code;
 *      an artifact's `deployedBytecode` is RUNTIME code. Use eth_getCode for the
 *      deployed runtime.
 *
 *   3. Expect two legitimate differences and nothing else:
 *        - the trailing CBOR metadata blob, whose source hash changes if a
 *          comment or the contract name changes; strip it before comparing.
 *        - every `immutable` slot. Solidity leaves immutables as ZERO
 *          placeholders in the compiled artifact and the constructor writes them
 *          at deploy time. Stock OZ 4 UUPS has `immutable __self = address(this)`,
 *          so the deployed code carries the implementation's OWN address in
 *          several places where the artifact carries zeros. That is expected —
 *          and it doubles as proof the contract really does use the stock
 *          immutable-based UUPS rather than a storage-slot variant.
 *
 * Compile for Tron first (`npx hardhat compile --network tron`): mainnet was
 * built with tron-solc 0.8.22, and standard solc produces different bytes.
 */
import hre from "hardhat";
import * as path from "path";

const HOST = "https://api.trongrid.io";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const TARGETS = [
  { label: "IDRP token", proxy: "TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r",
    artifact: "contracts/legacy/IDRPv2.sol:IDRPv2" },
  { label: "IDRP controller", proxy: "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX",
    artifact: "contracts/legacy/IDRPControllerv2.sol:IDRPControllerv2" },
];

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(`${HOST}/jsonrpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result as string;
}

/** Split runtime code into executable body and trailing CBOR metadata. */
function splitMetadata(hex: string) {
  const h = hex.replace(/^0x/, "");
  const len = parseInt(h.slice(-4), 16);
  if (!len || len * 2 + 4 > h.length) return { code: h, meta: "" };
  return { code: h.slice(0, h.length - 4 - len * 2), meta: h.slice(h.length - 4 - len * 2, h.length - 4) };
}

/** Every maximal run of differing bytes between two equal-length hex strings. */
function diffRuns(a: string, b: string) {
  const runs: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (let i = 0; i < Math.min(a.length, b.length) / 2; i++) {
    if (a.slice(i * 2, i * 2 + 2) !== b.slice(i * 2, i * 2 + 2)) {
      if (cur) cur.end = i;
      else { cur = { start: i, end: i }; runs.push(cur); }
    } else cur = null;
  }
  return runs;
}

const solcOf = (meta: string) => {
  const m = meta.match(/64736f6c6343([0-9a-f]{6})/);
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(".") : "?";
};

async function main() {
  const TronWeb = require("tronweb");
  const tw = new TronWeb({ fullHost: HOST });
  let failures = 0;

  for (const t of TARGETS) {
    const proxyHex = "0x" + tw.address.toHex(t.proxy).slice(2);
    const implHex = "0x" + (await rpc("eth_getStorageAt", [proxyHex, IMPL_SLOT, "latest"])).slice(-40);
    const implB58 = tw.address.fromHex("41" + implHex.slice(2));
    const deployed = (await rpc("eth_getCode", [implHex, "latest"])).replace(/^0x/, "");

    const art = await hre.artifacts.readArtifact(t.artifact);
    const D = splitMetadata(deployed);
    const C = splitMetadata(art.deployedBytecode);

    console.log(`\n${"━".repeat(84)}`);
    console.log(`${t.label}`);
    console.log(`  proxy          ${t.proxy}`);
    console.log(`  implementation ${implB58}  (${implHex})`);
    console.log(`  candidate      ${t.artifact}`);
    console.log(`${"━".repeat(84)}`);
    console.log(`  executable bytes   deployed ${D.code.length / 2}   candidate ${C.code.length / 2}`);
    console.log(`  metadata solc      deployed ${solcOf(D.meta)}   candidate ${solcOf(C.meta)}`);

    if (D.code.length !== C.code.length) {
      console.log(`\n  ✗ LENGTH DIFFERS — this is not the deployed source`);
      failures++;
      continue;
    }

    const runs = diffRuns(D.code, C.code);
    const own = implHex.replace(/^0x/, "").toLowerCase();
    let unexplained = 0;
    console.log(`\n  differing byte-runs: ${runs.length}`);
    for (const r of runs) {
      const dep = D.code.slice(r.start * 2, (r.end + 1) * 2);
      const cand = C.code.slice(r.start * 2, (r.end + 1) * 2);
      const isImmutable = dep.toLowerCase() === own && /^0+$/.test(cand);
      if (!isImmutable) unexplained++;
      console.log(`    @${String(r.start).padStart(6)} len ${String(r.end - r.start + 1).padStart(3)}  ` +
        (isImmutable ? "immutable __self (own address vs zero placeholder) ✓" : `UNEXPLAINED  deployed=${dep} candidate=${cand}`));
    }

    if (unexplained === 0) {
      console.log(`\n  ✓ MATCH — identical apart from ${runs.length} immutable placeholder(s).`);
      console.log(`    ${runs.length} occurrences of the contract's own address also confirm stock OZ 4`);
      console.log(`    UUPS (immutable __self), not a storage-slot proxy check.`);
    } else {
      console.log(`\n  ✗ ${unexplained} unexplained difference(s) — NOT the deployed source`);
      failures++;
    }
  }

  console.log(`\n${failures === 0 ? "ALL TARGETS VERIFIED" : failures + " TARGET(S) FAILED"}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error("\n✗", e.message ?? e); process.exit(1); });

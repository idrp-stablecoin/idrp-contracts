import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import hre from "hardhat";

/**
 * Verifies the testnet env's contracts on the block explorer from the compiler
 * input recorded at deploy time (deployment/builds/), so what gets verified is
 * the 5-minute build that is on chain, not the 48h tree.
 *
 *   npx hardhat run scripts/verify-testnet-builds.ts --network baseSepolia
 *   npx hardhat run scripts/verify-testnet-builds.ts --network kairos
 *
 * Before submitting anything it compiles each recorded input locally and
 * checks the result against the chain, byte for byte including metadata; a
 * contract that fails that check is not submitted.
 *
 * DRY_RUN=1 runs the local check only and submits nothing.
 *
 * Explorers: Base Sepolia through the Etherscan v2 API (ETHERSCAN_API_KEY),
 * Kairos through Kaiascan's verification API. The proxies are linked to their
 * implementation where the explorer supports it.
 */

const ENV = "testnet";
const EXPLORERS: Record<number, { api: string; browser: string; key: () => string; linksProxies: boolean }> = {
  84532: {
    api: "https://api.etherscan.io/v2/api?chainid=84532",
    browser: "https://sepolia.basescan.org/address/",
    key: () => String(hre.config.etherscan.apiKey),
    linksProxies: true,
  },
  1001: {
    api: "https://compiler-api-v2.kaiascan.io/kairos/hardhat-verify",
    browser: "https://kairos.kaiascan.io/address/",
    key: () => "kaiascan",
    linksProxies: false,
  },
};

type Build = { contract: string; compiler: string; input: any };
type Target = { label: string; address: string; build: Build };

const root = hre.config.paths.root;

async function rpc(method: string, params: unknown[]) {
  return hre.ethers.provider.send(method, params);
}

/** Compiles a recorded input with its own compiler; returns runtime code + immutables. */
async function compileRecorded(build: Build) {
  const version = build.compiler.replace(/^v/, "").split("+")[0];
  const solc = await hre.run("compile:solidity:solc:get-build", { quiet: true, solcVersion: version });
  if (solc.isSolcJs) throw new Error(`solc ${version} is only available as solcjs here`);
  const out = JSON.parse(
    execSync(`"${solc.compilerPath}" --standard-json`, { input: JSON.stringify(build.input), maxBuffer: 1 << 28 }).toString()
  );
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(`${build.contract}: ${errors[0].formattedMessage}`);
  const [source, name] = build.contract.split(":");
  const c = out.contracts[source][name];
  return {
    code: Buffer.from(c.evm.deployedBytecode.object, "hex"),
    immutables: Object.values((c.evm.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>).flat(),
  };
}

async function matchesChain(t: Target): Promise<string | null> {
  const { code, immutables } = await compileRecorded(t.build);
  const deployed = Buffer.from((await rpc("eth_getCode", [t.address, "latest"])).slice(2), "hex");
  const self = Buffer.from(t.address.slice(2).toLowerCase(), "hex");
  if (deployed.length !== code.length) return `length ${deployed.length} != ${code.length}`;
  for (const { start, length } of immutables) {
    if (!deployed.subarray(start + length - 20, start + length).equals(self)) return `immutable at ${start} is not the contract's own address`;
    deployed.fill(0, start, start + length);
    code.fill(0, start, start + length);
  }
  return deployed.equals(code) ? null : "bytes differ";
}

async function explorerCall(api: string, params: Record<string, string>, method: "GET" | "POST") {
  const url = new URL(api);
  const body = new URLSearchParams(params);
  const res =
    method === "POST"
      ? await fetch(url, { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body })
      : await fetch(`${url}${url.search ? "&" : "?"}${body}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`explorer answered ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function poll(api: string, key: string, action: string, guid: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const r = await explorerCall(api, { module: "contract", action, guid, apikey: key }, "GET");
    if (!/pending|queue/i.test(String(r.result))) return String(r.result);
  }
  return "still pending — check the explorer";
}

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const explorer = EXPLORERS[chainId];
  if (!explorer) throw new Error(`no explorer configured for chainId ${chainId}`);
  const recordFile = path.join(root, "deployment", ENV, `chain-${chainId}.json`);
  if (!fs.existsSync(recordFile)) throw new Error(`${path.relative(root, recordFile)} not found — deploy first`);
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const load = (p: string): Build => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

  const targets: Target[] = [
    { label: "IDRP implementation", address: record.IDRPImpl, build: load(record.IDRPBuild) },
    { label: "IDRPController implementation", address: record.IDRPControllerImpl, build: load(record.IDRPControllerBuild) },
  ];

  // The sanctions list has no delay constant, so the tree builds it exactly.
  await hre.run("compile", { quiet: true });
  const fqn = "contracts/sanctions/SanctionsList.sol:SanctionsList";
  const info = await hre.artifacts.getBuildInfo(fqn);
  const meta = JSON.parse((info!.output.contracts["contracts/sanctions/SanctionsList.sol"].SanctionsList as any).metadata);
  const sources = Object.fromEntries(Object.keys(meta.sources).map((f) => [f, info!.input.sources[f]]));
  targets.push({
    label: "SanctionsList",
    address: record.sanctionsList,
    build: { contract: fqn, compiler: `v${info!.solcLongVersion}`, input: { ...info!.input, sources } },
  });

  console.log(`network ${hre.network.name} (chainId ${chainId}), record ${path.relative(root, recordFile)}\n`);
  for (const t of targets) {
    const mismatch = await matchesChain(t);
    if (mismatch) {
      console.log(`✗ ${t.label} ${t.address}: the recorded build does not reproduce it (${mismatch}) — not submitted`);
      continue;
    }
    if (process.env.DRY_RUN) {
      console.log(`✓ ${t.label} ${t.address}: recorded build reproduces the chain exactly (dry run, not submitted)`);
      continue;
    }
    const submit = await explorerCall(
      explorer.api,
      {
        module: "contract",
        action: "verifysourcecode",
        apikey: explorer.key(),
        contractaddress: t.address,
        sourceCode: JSON.stringify(t.build.input),
        codeformat: "solidity-standard-json-input",
        contractname: t.build.contract,
        compilerversion: t.build.compiler,
        constructorArguements: "",
      },
      "POST"
    );
    let verdict = String(submit.result);
    if (submit.status === "1") verdict = await poll(explorer.api, explorer.key(), "checkverifystatus", String(submit.result));
    console.log(`${/pass|verified/i.test(verdict) ? "✓" : "✗"} ${t.label} ${t.address}: ${verdict}`);
    console.log(`  ${explorer.browser}${t.address}#code`);
  }

  if (process.env.DRY_RUN) return;
  if (explorer.linksProxies) {
    for (const [label, proxy, impl] of [
      ["IDRP proxy", record.IDRP, record.IDRPImpl],
      ["IDRPController proxy", record.IDRPController, record.IDRPControllerImpl],
    ]) {
      const r = await explorerCall(
        explorer.api,
        { module: "contract", action: "verifyproxycontract", apikey: explorer.key(), address: proxy, expectedimplementation: impl },
        "POST"
      );
      const verdict = r.status === "1" ? await poll(explorer.api, explorer.key(), "checkproxyverification", String(r.result)) : String(r.result);
      console.log(`${/success|verified|found/i.test(verdict) ? "✓" : "✗"} ${label} ${proxy}: ${verdict}`);
    }
  } else {
    console.log(`\nProxies ${record.IDRP} and ${record.IDRPController}: the explorer detects ERC-1967 proxies itself.`);
  }
}

main().catch((e) => {
  console.error("\n" + (e.message ?? e));
  process.exitCode = 1;
});

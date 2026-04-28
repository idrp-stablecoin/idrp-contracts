import fs from "fs";
import path from "path";
import hre from "hardhat";
import { hexToTron } from "./utils/addressConverter";

/**
 * Verifies IDRP and IDRPController contracts on TronScan.
 *
 * Usage:
 *   npx hardhat run scripts/verify-tron.ts --network shasta
 *   npx hardhat run scripts/verify-tron.ts --network tron
 *
 * Reads deployment addresses from: deployments/<network>/
 * Reads source code from:          flattened/
 *
 * IMPORTANT: COMPILER_VERSION must match the version used to deploy.
 * Check artifacts-tron/build-info/*.json for "compiler.version".
 */

// ── Config ────────────────────────────────────────────────────────────────────

// Must match the version in artifacts-tron/build-info/*.json > compiler.version
// Format expected by TronScan: "v<version>+commit.<hash>"
const COMPILER_VERSION = "v0.8.28+commit.7893614a";

const OPTIMIZATION      = true;
const OPTIMIZATION_RUNS = 200;
const EVM_VERSION       = "cancun";

// MIT licence type code used by TronScan
const LICENSE_TYPE = 3;

// ── TronScan endpoints ────────────────────────────────────────────────────────
const TRONSCAN: Record<string, { api: string; browser: string }> = {
  shasta: {
    api:     "https://shastapi.tronscan.org/api/contracts/verify",
    browser: "https://shasta.tronscan.org/#/contract",
  },
  tron: {
    api:     "https://apilist.tronscan.io/api/contracts/verify",
    browser: "https://tronscan.org/#/contract",
  },
};

// ── Flattened source map ──────────────────────────────────────────────────────
const FLATTENED_DIR = path.join(process.cwd(), "flattened");
const SOURCES: Record<string, string> = {
  IDRP:           "IDRP_Flattened_hh.sol",
  IDRPController: "IDRPController_Flattened_hh.sol",
  ERC1967Proxy:   "ERC1967Proxy_Flattened_hh.sol",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

interface DeploymentJson {
  address: string; // hex (0x...) – hardhat-deploy stores addresses in hex
}

function readDeployment(deploymentsDir: string, name: string): DeploymentJson | null {
  const file = path.join(deploymentsDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.log(`  No ${name}.json found at ${file} – skipping.`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as DeploymentJson;
}

function readSource(contractName: string): string {
  const sourceFile = SOURCES[contractName];
  if (!sourceFile) {
    throw new Error(`No flattened source mapped for contract "${contractName}"`);
  }
  const fullPath = path.join(FLATTENED_DIR, sourceFile);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Flattened source not found: ${fullPath}\nRun: npx hardhat flatten > flattened/${sourceFile}`);
  }
  return fs.readFileSync(fullPath, "utf-8");
}

async function verifySingleContract(
  apiUrl: string,
  browserUrl: string,
  label: string,
  hexAddress: string,
  contractName: string,
): Promise<void> {
  const base58Address = hexToTron(hexAddress);
  const sourceCode    = readSource(contractName);

  console.log(`\nVerifying ${label}...`);
  console.log(`  Hex    : ${hexAddress}`);
  console.log(`  Base58 : ${base58Address}`);
  console.log(`  Source : ${SOURCES[contractName]}`);
  console.log(`  Compiler: ${COMPILER_VERSION}  optimization: ${OPTIMIZATION}  runs: ${OPTIMIZATION_RUNS}  evm: ${EVM_VERSION}`);

  const body = {
    contractAddress:  base58Address,
    contractName,
    compilerVersion:  COMPILER_VERSION,
    optimization:     OPTIMIZATION,
    optimizationRuns: OPTIMIZATION_RUNS,
    evmVersion:       EVM_VERSION,
    sourceCode,
    licenseType:      LICENSE_TYPE,
  };

  try {
    const response = await fetch(apiUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    const text = await response.text();

    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }

    if (!response.ok) {
      console.error(`  ✗ HTTP ${response.status}: ${text}`);
      return;
    }

    // TronScan may return { status: true } or { code: 0 } or { verified: true }
    const ok =
      json["status"] === true ||
      json["status"] === "1" ||
      json["verified"] === true ||
      (typeof json["code"] === "number" && json["code"] === 0);

    const alreadyVerified =
      typeof json["message"] === "string" &&
      (json["message"] as string).toLowerCase().includes("already verified");

    if (alreadyVerified) {
      console.log(`  ✓ ${label} already verified`);
      console.log(`    ${browserUrl}/${base58Address}`);
    } else if (ok) {
      console.log(`  ✓ ${label} verified`);
      console.log(`    ${browserUrl}/${base58Address}`);
    } else {
      // Print full response so the caller can diagnose
      console.warn(`  ? ${label} – unexpected response:`);
      console.warn(`    ${text}`);
      console.warn(`  Verify manually: ${browserUrl}/${base58Address}`);
    }
  } catch (err) {
    console.error(`  ✗ ${label} error: ${(err as Error).message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const network = hre.network.name;

  if (!(network in TRONSCAN)) {
    throw new Error(
      `Network "${network}" is not a supported Tron network.\n` +
        `Supported: ${Object.keys(TRONSCAN).join(", ")}\n` +
        `For EVM networks use: npx hardhat run scripts/verify.ts --network <network>`
    );
  }

  const { api: apiUrl, browser: browserUrl } = TRONSCAN[network];
  const deploymentsDir = path.join(process.cwd(), "deployments", network);

  if (!fs.existsSync(deploymentsDir)) {
    throw new Error(
      `Deployments directory not found: ${deploymentsDir}\n` +
        `Run the deploy script first: npx hardhat deploy --network ${network}`
    );
  }

  console.log(`\n=== TronScan Contract Verification ===`);
  console.log(`Network  : ${network}`);
  console.log(`API      : ${apiUrl}`);
  console.log(`Compiler : ${COMPILER_VERSION}`);

  // ── IDRP ────────────────────────────────────────────────────────────────────
  const idrpImpl  = readDeployment(deploymentsDir, "IDRP_Implementation");
  const idrpProxy = readDeployment(deploymentsDir, "IDRP_Proxy");

  if (idrpImpl) {
    await verifySingleContract(apiUrl, browserUrl, "IDRP (implementation)", idrpImpl.address, "IDRP");
  }
  if (idrpProxy) {
    await verifySingleContract(apiUrl, browserUrl, "IDRP (proxy)", idrpProxy.address, "ERC1967Proxy");
  }

  // ── IDRPController ───────────────────────────────────────────────────────────
  const ctrlImpl  = readDeployment(deploymentsDir, "IDRPController_Implementation");
  const ctrlProxy = readDeployment(deploymentsDir, "IDRPController_Proxy");

  if (ctrlImpl) {
    await verifySingleContract(apiUrl, browserUrl, "IDRPController (implementation)", ctrlImpl.address, "IDRPController");
  }
  if (ctrlProxy) {
    await verifySingleContract(apiUrl, browserUrl, "IDRPController (proxy)", ctrlProxy.address, "ERC1967Proxy");
  }

  console.log("\n=== Done ===\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

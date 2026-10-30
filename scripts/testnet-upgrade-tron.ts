import fs from "fs";
import path from "path";
import hre from "hardhat";
import { tronNetwork } from "./utils/tron-network";
import { assertBuildInputsCommitted, deployImplementation, type Kind } from "./utils/tron-impl";
import { assertOz4TronOnly } from "./utils/assert-oz4-tron-only";
import { printHeader } from "./utils/tron-steps";

/**
 * Deploys a v3 implementation for the testnet env on Nile, or for a local TVM rehearsal of
 * it: this tree with every timelock constant cut to 5 minutes for the build, restored
 * straight after. Nothing is committed. The rest — the funding gate, the dry run, the
 * deployed-code proof, the build record — is the code the mainnet deploy scripts run.
 *
 *   TARGET=controller npx hardhat run scripts/testnet-upgrade-tron.ts --network nile
 *   TARGET=controller EXECUTE=1 npx hardhat run scripts/testnet-upgrade-tron.ts --network nile
 *   (TARGET=token for the token; --network tre with TRE_RECORD=<record> for a local rehearsal)
 *
 * Then schedule, execute and verify with the scripts mainnet uses:
 * tron-schedule-*-upgrade.ts, tron-execute-*-upgrade.ts, tron-verify-v3.ts.
 *
 * Records (Nile): deployment/testnet/tron/nile.json (upgrades[]) and
 * deployment/builds/3448148188/<implementation>.json, the exact compiler input of the
 * 5-minute build — what Tronscan verification needs.
 */

const DELAY_TEXT = "5 minutes";

/** Every timelock constant in the v3 tree; each is edited for the testnet build. */
const DELAY_LINES: Array<[string, string]> = [
  ["contracts/IDRP.sol", "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  ["contracts/IDRP.sol", "    uint48 public constant AUTHORITY_TRANSFER_DELAY = 48 hours;"],
  ["contracts/IDRPController.sol", "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  ["contracts/IDRPController.sol", "    uint48 public constant DEFAULT_ADMIN_DELAY = 48 hours;"],
];

const root = hre.config.paths.root;

/** Compiles with every delay at 5 minutes, runs `fn`, then restores the sources and rebuilds. */
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
  for (const [file, src] of patched) {
    const left = src.match(/constant\s+\w*DELAY\w*\s*=\s*48 hours/g);
    if (left) throw new Error(`${file}: ${left.join(", ")} would stay at 48 hours — DELAY_LINES is out of date`);
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
  if (hre.network.name !== "nile" && hre.network.name !== "tre") {
    throw new Error(`REFUSING --network ${hre.network.name}: this builds the 5-minute testnet implementations, for nile (or tre locally) only.`);
  }
  const target = (process.env.TARGET ?? "").toLowerCase();
  if (target !== "controller" && target !== "token") throw new Error(`Set TARGET=controller or TARGET=token`);
  await assertOz4TronOnly(hre);
  const local = hre.network.name === "tre";
  const commit = local ? (await import("child_process")).execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim() : assertBuildInputsCommitted(hre);
  const net = await tronNetwork(hre);
  printHeader(net, `deploy the ${target} v3 implementation — testnet build (${DELAY_TEXT})`);
  const impl = await withTestnetDelays(() => deployImplementation(hre, net, target as Kind, commit));
  if (impl) {
    const next = target === "controller" ? "tron-schedule-controller-upgrade.ts" : "tron-schedule-idrp-upgrade.ts";
    console.log(`\nNext: schedule it (dry run first):`);
    console.log(`  IMPL=${impl} npx hardhat run scripts/${next} --network ${net.name}`);
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e.message ?? e}`);
  process.exitCode = 1;
});

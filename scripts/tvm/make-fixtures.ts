/**
 * Generate the local-TVM fixtures used by the rehearsal scripts.
 *
 * WHY THIS EXISTS
 *   Both the v2 and v3 contracts hard-code `UPGRADE_DELAY = 48 hours`. A local
 *   TVM rehearsal cannot wait two days, so an earlier run was done with a
 *   hand-edit that was reverted before committing — which meant a clean checkout
 *   could not reproduce it. That is exactly the class of drift that caused the
 *   Nile incident, so the shortening is now generated, committed and checked.
 *
 * TWO GROUPS
 *   "Tvm"       — the real sources, delay shortened. Used by the rehearsals.
 *   "TronUups"  — the v3 sources with the UUPS base swapped to the in-house
 *                 TronUUPSUpgradeable, so the freeze can be demonstrated on the
 *                 REAL Controller and Token rather than on a mock.
 *
 * PERMITTED EDITS — anything else and generation fails
 *   1. UPGRADE_DELAY = 48 hours   ->  = <TVM_UPGRADE_DELAY> seconds
 *   2. relative imports "./x"     ->  "../x"   (the file moved down one level)
 *   3. the contract DECLARATION line gets a suffix. Declaration only: a global
 *      rename would also rewrite the string literals __ERC20_init("IDRP","IDRP")
 *      and keccak256(bytes("IDRPController")), and rewriting the latter changes
 *      DOMAIN_SEPARATOR — the exact value the rehearsal exists to prove survives.
 *   4. (TronUups group only) TronGaplessUUPSUpgradeable -> TronUUPSUpgradeable
 *
 * Every transform is inverted and compared against the original byte for byte, so
 * a source change this script does not understand fails loudly instead of quietly
 * rehearsing against something that is not what we ship.
 *
 *   npx hardhat run scripts/tvm/make-fixtures.ts
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(ROOT, "contracts/tvm-fixtures");
const DELAY_SECONDS = Number(process.env.TVM_UPGRADE_DELAY ?? 60);

type Job = { src: string; suffix: string; swapBase: boolean; out: string };

const JOBS: Job[] = [
  { src: "contracts/legacy/IDRPv2.sol", suffix: "Tvm", swapBase: false, out: "IDRPv2.sol" },
  { src: "contracts/legacy/IDRPControllerv2.sol", suffix: "Tvm", swapBase: false, out: "IDRPControllerv2.sol" },
  { src: "contracts/IDRP.sol", suffix: "Tvm", swapBase: false, out: "IDRP.sol" },
  { src: "contracts/IDRPController.sol", suffix: "Tvm", swapBase: false, out: "IDRPController.sol" },
  // Same v3 sources, but on the storage-slot UUPS base. These must never be deployed.
  { src: "contracts/IDRP.sol", suffix: "TronUups", swapBase: true, out: "IDRPTronUups.sol" },
  { src: "contracts/IDRPController.sol", suffix: "TronUups", swapBase: true, out: "IDRPControllerTronUups.sol" },
];

const GAPLESS = "TronGaplessUUPSUpgradeable";
const SLOTTED = "TronUUPSUpgradeable";

const HEADER = (j: Job, contractName: string) => `// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.  Regenerate with:
//     npx hardhat run scripts/tvm/make-fixtures.ts
//
// Source: ${j.src}   ->   contract ${contractName}
// The ONLY changes vs that source are:
//   - UPGRADE_DELAY shortened to ${DELAY_SECONDS} seconds so a local TVM
//     rehearsal can actually run (the real sources keep 48 hours)
//   - relative imports rewritten one directory level up
//   - the contract DECLARATION renamed with a "${j.suffix}" suffix (declaration
//     line only — string literals untouched, so DOMAIN_SEPARATOR is unchanged)${j.swapBase ? `
//   - UUPS base swapped ${GAPLESS} -> ${SLOTTED}
//
// TEST FIXTURE ONLY — NEVER DEPLOY. This is the storage-slot UUPS base that
// permanently froze the Nile Controller. It exists so the freeze can be shown on
// the real contract instead of on a mock.` : ""}
// Generation fails if anything else would differ.
// ─────────────────────────────────────────────────────────────────────────────
`;

function transform(text: string, j: Job): string {
  let out = text.replace(
    /(uint256\s+public\s+constant\s+UPGRADE_DELAY\s*=\s*)48 hours(\s*;)/,
    `$1${DELAY_SECONDS} seconds$2`,
  );
  out = out.replace(/(^import\s[^;]*?from\s+")\.\//gm, "$1../");
  out = out.replace(/^contract\s+([A-Za-z0-9_]+)(\s)/m, `contract $1${j.suffix}$2`);
  if (j.swapBase) out = out.split(GAPLESS).join(SLOTTED);
  return out;
}

function invert(text: string, j: Job): string {
  let back = text;
  if (j.swapBase) back = back.split(SLOTTED).join(GAPLESS);
  back = back.replace(
    new RegExp(`(uint256\\s+public\\s+constant\\s+UPGRADE_DELAY\\s*=\\s*)${DELAY_SECONDS} seconds(\\s*;)`),
    "$148 hours$2",
  );
  back = back.replace(/(^import\s[^;]*?from\s+")\.\.\//gm, "$1./");
  back = back.replace(new RegExp(`^contract\\s+([A-Za-z0-9_]+)${j.suffix}(\\s)`, "m"), "contract $1$2");
  return back;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failures = 0;

  for (const j of JOBS) {
    const original = fs.readFileSync(path.join(ROOT, j.src), "utf8");

    if (!/uint256\s+public\s+constant\s+UPGRADE_DELAY\s*=\s*48 hours\s*;/.test(original)) {
      console.error(`  ✗ ${j.src}: no 'UPGRADE_DELAY = 48 hours' found — refusing to guess`);
      failures++;
      continue;
    }
    if (j.swapBase && !original.includes(GAPLESS)) {
      console.error(`  ✗ ${j.src}: expected ${GAPLESS} to swap — not found`);
      failures++;
      continue;
    }

    const transformed = transform(original, j);

    // The safety net: reversing the transform must reproduce the source byte for byte.
    if (invert(transformed, j) !== original) {
      console.error(`  ✗ ${j.src}: transform is not cleanly reversible — the source changed shape`);
      failures++;
      continue;
    }

    const cn = (transformed.match(/^contract\s+([A-Za-z0-9_]+)/m) ?? [])[1];
    fs.writeFileSync(path.join(OUT_DIR, j.out), HEADER(j, cn) + transformed);
    console.log(`  ✓ ${j.src.padEnd(38)} ->  ${j.out.padEnd(28)} contract ${cn}`);
  }

  if (failures) {
    console.error(`\n${failures} fixture(s) could not be generated safely.`);
    process.exit(1);
  }
  console.log(`\n${JOBS.length} fixtures written to contracts/tvm-fixtures/ (UPGRADE_DELAY=${DELAY_SECONDS}s).`);
}

main();

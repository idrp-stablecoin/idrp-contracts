/**
 * Generate the local-TVM fixtures used by the rehearsal scripts.
 *
 * WHY THIS EXISTS
 *   Both the v2 and v3 contracts hard-code `UPGRADE_DELAY = 48 hours`. A local
 *   TVM rehearsal cannot wait two days, so the earlier run was done with a
 *   hand-edit that was reverted before committing — which meant a clean checkout
 *   could not reproduce it. That is exactly the class of drift that caused the
 *   Nile incident, so the shortening is now generated, committed and checked.
 *
 * WHAT IT DOES
 *   Copies each source into contracts/tvm-fixtures/ applying ONLY:
 *     1. UPGRADE_DELAY = 48 hours  ->  UPGRADE_DELAY = <TVM_UPGRADE_DELAY> seconds
 *     2. relative imports "./x"    ->  "../x"   (the file moved down one level)
 *   then asserts that NOTHING ELSE differs. If a source changes in a way this
 *   transform does not understand, generation fails loudly instead of silently
 *   rehearsing against something that is not what we ship.
 *
 *     3. the contract declaration gets a "Tvm" suffix, so fixtures never collide
 *        with the real artifacts (hardhat cannot resolve a duplicate short name).
 *
 *   npx hardhat run scripts/tvm/make-fixtures.ts
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(ROOT, "contracts/tvm-fixtures");
const DELAY_SECONDS = Number(process.env.TVM_UPGRADE_DELAY ?? 60);
const SUFFIX = "Tvm";

const SOURCES = [
  "contracts/legacy/IDRPv2.sol",
  "contracts/legacy/IDRPControllerv2.sol",
  "contracts/IDRP.sol",
  "contracts/IDRPController.sol",
];

const HEADER = (src: string) => `// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.  Regenerate with:
//     npx hardhat run scripts/tvm/make-fixtures.ts
//
// Source: ${src}
// The ONLY changes vs that source are:
//   - UPGRADE_DELAY shortened to ${DELAY_SECONDS} seconds so a local TVM
//     rehearsal can actually run (the real sources keep 48 hours)
//   - relative imports rewritten one directory level up
//   - the contract DECLARATION renamed with a "${SUFFIX}" suffix (declaration
//     line only — string literals are untouched, so DOMAIN_SEPARATOR is unchanged)
// Generation fails if anything else would differ.
// ─────────────────────────────────────────────────────────────────────────────
`;

/** Apply the three permitted edits. Returns the transformed text. */
function transform(text: string): string {
  let out = text.replace(
    /(uint256\s+public\s+constant\s+UPGRADE_DELAY\s*=\s*)48 hours(\s*;)/,
    `$1${DELAY_SECONDS} seconds$2`,
  );
  out = out.replace(/(^import\s[^;]*?from\s+")\.\//gm, "$1../");
  // Rename ONLY the declaration line. A global rename would also hit the string
  // literals __ERC20_init("IDRP", "IDRP") and keccak256(bytes("IDRPController")),
  // and rewriting the latter would change DOMAIN_SEPARATOR — the exact value the
  // rehearsal exists to prove is preserved.
  out = out.replace(/^contract\s+([A-Za-z0-9_]+)(\s)/m, `contract $1${SUFFIX}$2`);
  return out;
}

/** Undo the permitted edits, so we can prove nothing else moved. */
function invert(text: string): string {
  let back = text.replace(
    new RegExp(`(uint256\\s+public\\s+constant\\s+UPGRADE_DELAY\\s*=\\s*)${DELAY_SECONDS} seconds(\\s*;)`),
    "$148 hours$2",
  );
  back = back.replace(/(^import\s[^;]*?from\s+")\.\.\//gm, "$1./");
  back = back.replace(new RegExp(`^contract\\s+([A-Za-z0-9_]+)${SUFFIX}(\\s)`, "m"), "contract $1$2");
  return back;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failures = 0;

  for (const rel of SOURCES) {
    const abs = path.join(ROOT, rel);
    const original = fs.readFileSync(abs, "utf8");

    if (!/uint256\s+public\s+constant\s+UPGRADE_DELAY\s*=\s*48 hours\s*;/.test(original)) {
      console.error(`  ✗ ${rel}: no 'UPGRADE_DELAY = 48 hours' found — refusing to guess`);
      failures++;
      continue;
    }

    const transformed = transform(original);

    // The safety net: reversing the transform must reproduce the source byte for byte.
    if (invert(transformed) !== original) {
      console.error(`  ✗ ${rel}: transform is not cleanly reversible — the source changed shape`);
      failures++;
      continue;
    }

    const target = path.join(OUT_DIR, path.basename(rel));
    fs.writeFileSync(target, HEADER(rel) + transformed);
    const cn = (transformed.match(/^contract\s+([A-Za-z0-9_]+)/m) ?? [])[1];
    console.log(`  ✓ ${rel}  ->  contracts/tvm-fixtures/${path.basename(rel)}  contract ${cn}  (UPGRADE_DELAY=${DELAY_SECONDS}s)`);
  }

  if (failures) {
    console.error(`\n${failures} fixture(s) could not be generated safely.`);
    process.exit(1);
  }
  console.log(`\nFixtures written to contracts/tvm-fixtures/ (contract names suffixed "${SUFFIX}").`);
}

main();

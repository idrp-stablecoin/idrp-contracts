/**
 * Refuse to run an OpenZeppelin 4.x build against an EVM chain.
 *
 * WHY THIS EXISTS
 *   The two chain families diverged and the repo cannot express both at once —
 *   one package.json, one OZ major.
 *
 *     Tron mainnet  IDRP/IDRPController are OZ 4 — sequential storage. The token's
 *                   own variables sit at slots 504-510, `_paused` at 101.
 *     EVM mainnets  the same contracts are OZ 5 — ERC-7201 namespaced storage.
 *                   Measured on Ethereum: totalSupply() matches the namespaced slot
 *                   keccak("openzeppelin.storage.ERC20")-1 &~0xff, +2, and the OZ 4
 *                   sequential slots read zero.
 *
 *   This branch pins OZ 4.9.6 so it can upgrade the Tron proxies without moving a
 *   single slot. Deploying the SAME sources to an EVM proxy would place every
 *   variable at a different offset — balances, roles and the upgrader would all be
 *   read from the wrong place. That mismatch, in the other direction, is exactly
 *   what produced the July OZ 5 implementations still scheduled on Tron.
 *
 *   So this is not a style rule. Getting it wrong is unrecoverable.
 *
 * Usage — first line of any script that deploys or upgrades:
 *     await assertOz4TronOnly(hre);
 */
import type { HardhatRuntimeEnvironment } from "hardhat/types";

/** Local chains used for unit tests; they never hold real state. */
const LOCAL = new Set(["hardhat", "localhost"]);

export async function assertOz4TronOnly(hre: HardhatRuntimeEnvironment) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const version: string = require("@openzeppelin/contracts-upgradeable/package.json").version;
  const major = Number(version.split(".")[0]);

  const name = hre.network.name;
  // @layerzerolabs/hardhat-tron marks TVM networks with `tron: true`.
  const isTron = Boolean((hre.network.config as any)?.tron) || (hre.network as any)?.tron === true;

  if (major !== 4) return;                       // OZ 5 build — this guard is not for it
  if (isTron || LOCAL.has(name)) return;         // Tron, or a throwaway local chain

  throw new Error(
    `\nRefusing to run: OpenZeppelin ${version} (v${major}) against network "${name}".\n` +
    `\n` +
    `  This branch is the TRON OZ 4 line. Tron's deployed proxies use OZ 4 sequential\n` +
    `  storage; the EVM mainnets use OZ 5 ERC-7201 namespaced storage. Deploying these\n` +
    `  sources to an EVM proxy would read every variable from the wrong slot.\n` +
    `\n` +
    `  For an EVM chain, use the OZ 5 branch instead.\n` +
    `  If you are certain this is a Tron network, check that its hardhat config sets\n` +
    `  \`tron: true\`.\n`,
  );
}

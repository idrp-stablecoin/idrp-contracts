/**
 * Cancel a pending scheduled upgrade on the Controller or the Token.
 *
 *   TARGET=token      npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
 *   TARGET=token      EXECUTE=1 npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
 *   (TARGET=controller for the Controller; --network nile | tre work the same way)
 *
 * A dry run unless EXECUTE=1: it simulates cancelUpgrade() from the signer, measures it
 * and checks the account can pay (scripts/utils/tron-preflight.ts). The signer must be
 * the upgrader; if that is a multisig, propose cancelUpgrade() through it instead.
 *
 * WHY THIS EXISTS
 *   The Tron mainnet Token still has an OpenZeppelin 5 implementation scheduled since
 *   2026-06-30. The live OZ 4 implementation exposes upgradeTo, so executing that schedule
 *   would swap in a build that reads every balance and role from the wrong storage. The
 *   first transaction of any mainnet session is this cancel.
 *
 *   scheduleUpgrade would also overwrite it (the deployed v2 has no pending-check), but
 *   cancelling first leaves scheduledImplementation == 0 as a checkpoint anyone can verify.
 */
import hre from "hardhat";
import { tronNetwork } from "./utils/tron-network";
import { cancelStep, printHeader } from "./utils/tron-steps";
import type { Kind } from "./utils/tron-impl";

async function main() {
  const target = (process.env.TARGET ?? "").toLowerCase();
  if (target !== "controller" && target !== "token") throw new Error(`Set TARGET=controller or TARGET=token (got "${process.env.TARGET ?? ""}")`);
  const net = await tronNetwork(hre);
  printHeader(net, `cancelUpgrade() — ${target}`);
  await cancelStep(net, target as Kind);
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

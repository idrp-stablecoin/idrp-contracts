/**
 * Schedule the IDRPController v2 → v3 upgrade: starts the timelock (48 h on mainnet, 5 min on
 * the testnet env).
 *
 *   IMPL=T… npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron
 *   IMPL=T… EXECUTE=1 npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron
 *
 * A dry run unless EXECUTE=1. Before anything is sent it checks, on chain, that IMPL is
 * the v3 build this network takes (UUPS, every timelock constant equal to this network's,
 * initializeV3 present and locked the OpenZeppelin 4 way), that the signer is the upgrader,
 * that nothing else is pending (REPLACE_PENDING=1 overwrites), and that the account can
 * pay (scripts/utils/tron-preflight.ts).
 *
 * If the upgrader is a multisig this script cannot sign: propose scheduleUpgrade(IMPL)
 * through the multisig.
 */
import hre from "hardhat";
import { tronNetwork } from "./utils/tron-network";
import { printHeader, scheduleStep } from "./utils/tron-steps";

async function main() {
  const net = await tronNetwork(hre);
  printHeader(net, `schedule the IDRPController upgrade`);
  await scheduleStep(net, "controller", process.env.IMPL);
  if (process.env.EXECUTE === "1") {
    console.log(`\nNext, once the delay has passed (dry run first):`);
    console.log(`  npx hardhat run scripts/tron-execute-controller-upgrade.ts --network ${net.name}`);
  }
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

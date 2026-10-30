/**
 * Tron mainnet: deploy the IDRP v3 implementation, built as committed (48-hour
 * timelocks). Any account can deploy it; the upgrader schedules it next.
 *
 *   npx hardhat run scripts/tron-deploy-idrp-v3-impl.ts --network tron
 *   EXECUTE=1 npx hardhat run scripts/tron-deploy-idrp-v3-impl.ts --network tron
 *
 * A dry run unless EXECUTE=1. It refuses when contracts/ or the lockfile have uncommitted
 * changes, compiles with tron-solc, checks the build's timelock constants, measures the
 * deploy and checks the account can pay for it before anything is sent
 * (scripts/utils/tron-preflight.ts). After the deploy it proves the code on chain is the
 * build, records the exact compiler input under deployment/builds/728126428/ and the deploy
 * in deployment/tron/mainnet.json (upgrades[]).
 *
 * The testnet env takes 5-minute builds, so on Nile (and the local TVM) the deploy runs
 * through scripts/testnet-upgrade-tron.ts on the tron-testnet trunk, which edits the delays
 * for the build and then calls the same deploy code.
 */
import hre from "hardhat";
import { tronNetwork } from "./utils/tron-network";
import { assertBuildInputsCommitted, deployImplementation } from "./utils/tron-impl";
import { assertOz4TronOnly } from "./utils/assert-oz4-tron-only";
import { printHeader } from "./utils/tron-steps";

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error(`REFUSING --network ${hre.network.name}: this deploys the 48-hour mainnet build. On a testnet use scripts/testnet-upgrade-tron.ts.`);
  }
  await assertOz4TronOnly(hre);
  const commit = assertBuildInputsCommitted(hre);
  await hre.run("compile", { quiet: true });
  const net = await tronNetwork(hre);
  printHeader(net, `deploy the IDRP v3 implementation`);
  const impl = await deployImplementation(hre, net, "token", commit);
  if (impl) {
    console.log(`\nNext: verify ${impl} on the explorer, then schedule it (dry run first):`);
    console.log(`  IMPL=${impl} npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron`);
  }
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

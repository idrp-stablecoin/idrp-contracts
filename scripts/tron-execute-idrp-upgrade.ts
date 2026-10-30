/**
 * Execute the scheduled IDRP (token) v2 → v3 upgrade, atomically:
 * upgradeToAndCall(scheduled, initializeV3(_admin, _controller, _upgrader)).
 *
 *   IDRP_V3_ADMIN=T… IDRP_V3_UPGRADER=T… \
 *     npx hardhat run scripts/tron-execute-idrp-upgrade.ts --network tron
 *   (the same with EXECUTE=1 to broadcast)
 *
 * IDRP_V3_ADMIN and IDRP_V3_UPGRADER are required; nothing defaults to the signer.
 * IDRP_V3_CONTROLLER defaults to the controller proxy in this network's record. Base58 T…
 * or 0x… only. Upgrade the controller first: a v3 controller drives a v2 token unchanged,
 * and the token holds every balance.
 *
 * A dry run unless EXECUTE=1. Before anything is sent it re-checks the scheduled
 * implementation on chain, simulates the exact atomic call from the signer and checks the
 * account can pay. Afterwards it checks admin, controller and upgrader, both TronUUPS slots
 * and that the upgrade gate still passes. Compare balances, supply and DOMAIN_SEPARATOR
 * with scripts/tron-verify-v3.ts (BASELINE=…).
 */
import hre from "hardhat";
import { tronNetwork } from "./utils/tron-network";
import { toEvmAddress } from "./utils/tron-address";
import { executeStep, printHeader } from "./utils/tron-steps";

async function main() {
  const net = await tronNetwork(hre);
  printHeader(net, "execute the IDRP token upgrade");
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required (base58 T… or 0x…). Nothing defaults to the signer.`);
    return v;
  };
  await executeStep(net, {
    kind: "token",
    admin: toEvmAddress(net.tw, need("IDRP_V3_ADMIN"), "IDRP_V3_ADMIN"),
    controller: toEvmAddress(net.tw, process.env.IDRP_V3_CONTROLLER ?? net.controller, "IDRP_V3_CONTROLLER"),
    upgrader: toEvmAddress(net.tw, need("IDRP_V3_UPGRADER"), "IDRP_V3_UPGRADER"),
  });
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

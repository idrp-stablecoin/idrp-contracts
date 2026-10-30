/**
 * Execute the scheduled IDRPController v2 → v3 upgrade, atomically:
 * upgradeToAndCall(scheduled, initializeV3(_admin, _upgrader, _legacyDefaultAdminHolders)).
 *
 *   CTRL_V3_ADMIN=T… CTRL_V3_UPGRADER=T… CTRL_V3_LEGACY_DAR_HOLDERS=T…,T… \
 *     npx hardhat run scripts/tron-execute-controller-upgrade.ts --network tron
 *   (the same with EXECUTE=1 to broadcast)
 *
 * All three are required; nothing defaults to the signer. CTRL_V3_LEGACY_DAR_HOLDERS is the
 * list scripts/tron-list-default-admin-holders.ts prints on the day: initializeV3 revokes
 * exactly those, so a holder left out keeps DEFAULT_ADMIN_ROLE. Base58 T… or 0x… only.
 *
 * A dry run unless EXECUTE=1. Before anything is sent it re-checks the scheduled
 * implementation on chain, confirms every listed holder holds the role, simulates the
 * exact atomic call from the signer and checks the account can pay. Afterwards it checks
 * the admin, the upgrader, the revocations, the quorum roles (no re-grant), both TronUUPS
 * slots and that the upgrade gate still passes.
 *
 * Never split this into upgradeTo + a separate initializeV3: the atomic call is what makes
 * a failure harmless (it rolls back). Splitting it is what deadlocked the Nile controller.
 */
import hre from "hardhat";
import { tronNetwork } from "./utils/tron-network";
import { toEvmAddress, toEvmAddressList } from "./utils/tron-address";
import { executeStep, printHeader } from "./utils/tron-steps";

async function main() {
  const net = await tronNetwork(hre);
  printHeader(net, "execute the IDRPController upgrade");
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required (base58 T… or 0x…). Nothing defaults to the signer.`);
    return v;
  };
  await executeStep(net, {
    kind: "controller",
    admin: toEvmAddress(net.tw, need("CTRL_V3_ADMIN"), "CTRL_V3_ADMIN"),
    upgrader: toEvmAddress(net.tw, need("CTRL_V3_UPGRADER"), "CTRL_V3_UPGRADER"),
    legacyDefaultAdmins: toEvmAddressList(net.tw, need("CTRL_V3_LEGACY_DAR_HOLDERS"), "CTRL_V3_LEGACY_DAR_HOLDERS"),
  });
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

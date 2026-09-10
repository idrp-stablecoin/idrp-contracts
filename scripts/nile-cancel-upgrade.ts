/**
 * Nile: cancel a pending scheduled upgrade on the Token or the Controller.
 *
 *   TARGET=token      npx hardhat run scripts/nile-cancel-upgrade.ts --network nile
 *   TARGET=controller npx hardhat run scripts/nile-cancel-upgrade.ts --network nile
 *
 * Dry run by default. Add EXECUTE=1 to broadcast.
 *
 * WHY A SEPARATE SCRIPT
 *   scripts/tron-cancel-upgrade.ts is hard-guarded to MAINNET on purpose. Rather
 *   than loosen that guard to reach Nile, this mirrors it for the testnet.
 *
 * WHY IT IS NEEDED HERE
 *   Read on-chain 2026-09-10, both Nile proxies carry pending schedules whose
 *   timelocks expired long ago:
 *     token      0xdb105680…  scheduled 2026-06-09  (an unverified v3 build)
 *     controller 0xd1ad64cc…  scheduled 2026-09-01
 *   Whether the token's carries LegacyAccessControlSlots' 100-slot reservation
 *   cannot be told from bytecode. Without it, executing shifts every variable by
 *   100 slots and bricks the token — the failure already on record for Nile.
 *   So: do not execute them. Cancel, then schedule something verified.
 *
 *   The contract's scheduleUpgrade overwrites unconditionally, so scheduling
 *   would also neutralise a pending one. Cancelling first is preferred: one
 *   explicit action, leaving scheduledImplementation == 0 as a checkpoint
 *   anybody can verify before something new is scheduled.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const PROXIES: Record<string, string> = {
  token: "TYdq9kGJQDSVxPeKH1zyXMuTgKK56tv1GU",
  controller: "TWTjirsqPT6DGC63RMSAHGtb2NdzauiJWy",
};

const ABI = [
  { inputs: [], name: "cancelUpgrade", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "scheduledImplementation", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "upgradeScheduledAt", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "upgrader", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
];

async function main() {
  if (hre.network.name !== "nile") {
    throw new Error(`Nile only (got ${hre.network.name}). Mainnet has its own script.`);
  }
  const target = process.env.TARGET;
  if (!target || !PROXIES[target]) throw new Error("Set TARGET=token|controller");
  const proxy = PROXIES[target];

  const { vars } = require("hardhat/config");
  const pkRaw: string = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = pkRaw.startsWith("0x") ? pkRaw.slice(2) : pkRaw;
  const tw = new TronWeb({ fullHost: "https://nile.trongrid.io", privateKey: pk });

  const me = tw.defaultAddress.base58;
  const c = await tw.contract(ABI, proxy);
  const scheduled: string = await c.scheduledImplementation().call();
  const at = await c.upgradeScheduledAt().call();
  const upgrader: string = await c.upgrader().call();

  const norm = (a: string) => tw.address.toHex(a).toLowerCase().replace(/^41/, "");
  console.log(`network     nile`);
  console.log(`target      ${target}  ${proxy}`);
  console.log(`caller      ${me}  (${norm(me)})`);
  console.log(`upgrader()  ${upgrader}`);
  console.log(`scheduled   ${scheduled}`);
  console.log(`scheduledAt ${at}  ${Number(at) ? new Date(Number(at) * 1000).toISOString() : ""}`);

  if (norm(me) !== norm(upgrader)) {
    throw new Error(`caller is not upgrader — refusing`);
  }
  const zero = /^(0x)?0*$/.test(String(scheduled).replace(/^41/, ""));
  if (zero) {
    console.log(`\nNothing pending. Nothing to cancel.`);
    return;
  }

  if (process.env.EXECUTE !== "1") {
    console.log(`\nDRY RUN. Would call cancelUpgrade() on ${proxy}.`);
    console.log(`Re-run with EXECUTE=1 to broadcast.`);
    return;
  }

  console.log(`\nCalling cancelUpgrade()...`);
  const tx = await c.cancelUpgrade().send({ feeLimit: 1_000_000_000, shouldPollResponse: true });
  console.log(`  tx ${typeof tx === "string" ? tx : JSON.stringify(tx)}`);

  const after: string = await c.scheduledImplementation().call();
  const clean = /^(0x)?0*$/.test(String(after).replace(/^41/, ""));
  console.log(`\nscheduledImplementation now ${after}  ${clean ? "— CLEARED ✓" : "⚠️ STILL SET"}`);
  if (!clean) throw new Error("cancel did not clear the schedule");
}

main().catch((e) => { console.error("\n" + (e.message ?? e)); process.exitCode = 1; });

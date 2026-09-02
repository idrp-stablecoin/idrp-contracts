/**
 * Tron MAINNET: cancel a pending scheduled upgrade on the Controller or the Token.
 *
 *   TARGET=controller npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
 *   TARGET=token      npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
 *
 * Add EXECUTE=1 to broadcast. Without it this is a read-only dry run that prints
 * exactly what would be sent.
 *
 * WHY THIS EXISTS
 *   Both mainnet proxies still carry an OZ 5 implementation scheduled in July.
 *   Neither can succeed, and the Token's is actively dangerous: the live OZ 4
 *   implementation still exposes `upgradeTo`, so executing it would swap in an
 *   OZ 5 implementation and brick the contract that holds every user balance.
 *   The existing cancel-upgrade*.ts scripts are EVM-only (hardhat-ethers plus
 *   deployment/chain-*.json) and cannot talk to Tron.
 *
 * NOTE ON REPLACEMENT
 *   The deployed v2 `scheduleUpgrade` overwrites `scheduledImplementation` and
 *   resets `upgradeScheduledAt` unconditionally — there is no "already pending"
 *   guard in the contract. So scheduling the new implementation would also
 *   neutralise the poisoned one. Cancelling first is still preferred: it is one
 *   explicit, auditable action, and it leaves `scheduledImplementation == 0` as a
 *   verifiable checkpoint before anything new is scheduled.
 *
 * Caller MUST be the current `upgrader()`. If that is a multisig, propose the
 * `cancelUpgrade()` call through TronLink/TronScan instead of running this.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const PROXIES: Record<string, { addr: string; label: string }> = {
  controller: { addr: "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX", label: "IDRPController" },
  token: { addr: "TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r", label: "IDRP token" },
};

const ABI = [
  { inputs: [], name: "upgrader", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "scheduledImplementation", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "upgradeScheduledAt", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "UPGRADE_DELAY", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "cancelUpgrade", outputs: [], stateMutability: "nonpayable", type: "function" },
];

const isZeroAddr = (s: string) => /^(0x)?(41)?0{40}$/.test(s.toLowerCase());

async function main() {
  if (hre.network.name !== "tron") throw new Error(`Tron MAINNET only (got ${hre.network.name})`);

  const target = (process.env.TARGET ?? "").toLowerCase();
  if (!PROXIES[target]) throw new Error(`Set TARGET=controller or TARGET=token (got "${process.env.TARGET ?? ""}")`);
  const { addr: proxyT, label } = PROXIES[target];
  const EXECUTE = process.env.EXECUTE === "1";

  const { vars } = require("hardhat/config");
  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: "https://api.trongrid.io", privateKey: pk });
  const meT = tw.address.fromPrivateKey(pk);

  console.log(`Network : tron (MAINNET)`);
  console.log(`Target  : ${label}  ${proxyT}`);
  console.log(`Caller  : ${meT}`);
  console.log(`Mode    : ${EXECUTE ? "EXECUTE — will broadcast" : "DRY RUN — nothing is sent"}\n`);

  const proxy = await tw.contract(ABI, proxyT);

  const scheduled = (await proxy.scheduledImplementation().call()).toString();
  if (isZeroAddr(scheduled)) {
    console.log(`scheduledImplementation is already 0x0 — nothing to cancel.`);
    return;
  }
  const at = Number(await proxy.upgradeScheduledAt().call());
  const delay = Number(await proxy.UPGRADE_DELAY().call());
  console.log(`Pending schedule:`);
  console.log(`  scheduledImplementation : ${scheduled}`);
  console.log(`  upgradeScheduledAt      : ${at}  (${new Date(at * 1000).toISOString()})`);
  console.log(`  executable after        : ${at + delay}  (${new Date((at + delay) * 1000).toISOString()})`);
  console.log(`  executable now          : ${Math.floor(Date.now() / 1000) >= at + delay ? "YES" : "no"}`);

  const upgrader = (await proxy.upgrader().call()).toString().toLowerCase();
  const upgraderHex = "0x" + upgrader.slice(-40);
  const meHex = ("0x" + tw.address.toHex(meT).slice(2)).toLowerCase();
  console.log(`\n  upgrader() : ${upgraderHex}`);
  console.log(`  caller     : ${meHex}`);
  if (upgraderHex !== meHex) {
    throw new Error(
      `Caller is not the upgrader. cancelUpgrade() is onlyUpgrader.\n` +
      `If the upgrader is a multisig, propose cancelUpgrade() via TronLink/TronScan instead.`,
    );
  }

  if (!EXECUTE) {
    console.log(`\nDRY RUN — would call cancelUpgrade() on ${proxyT}`);
    console.log(`Re-run with EXECUTE=1 to broadcast.`);
    return;
  }

  console.log(`\nCalling cancelUpgrade()...`);
  const tx = await proxy.cancelUpgrade().send({ feeLimit: 100_000_000, callValue: 0, shouldPollResponse: true });
  console.log(`  ✓ tx: ${tx}`);

  await new Promise((r) => setTimeout(r, 5000));
  const after = (await proxy.scheduledImplementation().call()).toString();
  console.log(`\nPost-cancel scheduledImplementation: ${after}`);
  console.log(isZeroAddr(after) ? `  ✓ cleared` : `  ✗ STILL SET — investigate before continuing`);
  if (!isZeroAddr(after)) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

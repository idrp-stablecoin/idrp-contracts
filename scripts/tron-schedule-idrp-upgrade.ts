/**
 * Tron mainnet-specific: schedule the v2 -> v3 upgrade of the IDRP proxy.
 *
 * Mirror of nile-schedule-idrp-upgrade.ts. Uses TronWeb directly (not
 * ethers/hardhat) because Tron RPC doesn't support eth_getTransactionCount
 * or eth_estimateGas.
 *
 * Caller MUST be the current upgrader() of the proxy. If the upgrader is a
 * multisig, this script will fail at the upgrader-check step — propose the
 * scheduleUpgrade tx through TronLink/TronScan instead.
 *
 * Mainnet differences from Nile:
 *   - fullHost is api.trongrid.io (mainnet RPC).
 *   - Proxy address from deployment/tron/mainnet.json.
 *   - 48-HOUR timelock (not 5 minutes). After this, wait two days before
 *     running scripts/tron-execute-idrp-upgrade.ts.
 *
 * ⚠ MAINNET: real TRX is spent. Confirm before running.
 *
 * Usage:
 *   IMPL=0x... npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error(`Tron MAINNET only (got ${hre.network.name})`);
  }
  const newImpl = process.env.IMPL;
  if (!newImpl || !/^0x[0-9a-fA-F]{40}$/.test(newImpl)) {
    throw new Error("Set IMPL=0x... to the v3 implementation address from tron-deploy-idrp-v3-impl.ts");
  }

  const { vars } = require("hardhat/config");
  const deployerPk = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const cleanedPk = deployerPk.startsWith("0x") ? deployerPk.slice(2) : deployerPk;

  const tronWeb = new TronWeb({
    fullHost: "https://api.trongrid.io",
    privateKey: cleanedPk,
  });

  const deployerAddress = tronWeb.address.fromPrivateKey(cleanedPk);
  console.log(`Network:          ${hre.network.name} (TRON MAINNET)`);
  console.log(`Deployer (T):     ${deployerAddress}`);
  console.log(`Deployer (hex):   0x${tronWeb.address.toHex(deployerAddress).slice(2)}`);

  // Tron mainnet IDRP proxy from deployment/tron/mainnet.json
  const proxyT = "TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r";
  console.log(`IDRP proxy:       ${proxyT}`);
  console.log(`New v3 impl:      ${newImpl}`);

  // Convert newImpl hex -> Tron T address (TronWeb prefers T-format)
  const newImplT = tronWeb.address.fromHex("41" + newImpl.slice(2));
  console.log(`New v3 impl (T):  ${newImplT}`);

  const abi = [
    {"inputs":[],"name":"upgrader","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"newImpl","type":"address"}],"name":"scheduleUpgrade","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[],"name":"scheduledImplementation","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"upgradeScheduledAt","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"UPGRADE_DELAY","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  ];
  const proxyContract = await tronWeb.contract(abi, proxyT);

  // Pre-flight: check upgrader() on chain matches deployer.
  const currentUpgrader = await proxyContract.upgrader().call();
  const currentUpgraderHex = "0x" + currentUpgrader.toString().toLowerCase().slice(2);
  const deployerHex = ("0x" + tronWeb.address.toHex(deployerAddress).slice(2)).toLowerCase();
  console.log(`upgrader() on-chain (hex): ${currentUpgraderHex}`);
  console.log(`deployer            (hex): ${deployerHex}`);
  if (currentUpgraderHex !== deployerHex) {
    throw new Error(
      `Caller ${deployerHex} is not the current upgrader ${currentUpgraderHex}.\n` +
      `If the upgrader is a multisig, propose the scheduleUpgrade tx via TronLink/TronScan instead.`
    );
  }

  // Pre-flight: 48h timelock sanity check. Mainnet should report 172800; if
  // anything else, something is wrong with the deployed contract.
  const delay = Number(await proxyContract.UPGRADE_DELAY().call());
  if (delay !== 48 * 3600) {
    console.warn(`⚠ UPGRADE_DELAY on this proxy is ${delay} sec (${delay / 3600} h), expected 172800 (48 h).`);
    console.warn(`  This is mainnet — if the delay is shorter, the timelock isn't protecting anything.`);
    console.warn(`  Aborting. Run with FORCE_DELAY_OK=1 to override.`);
    if (process.env.FORCE_DELAY_OK !== "1") {
      process.exit(1);
    }
  }

  // Check no existing pending schedule.
  const existing = await proxyContract.scheduledImplementation().call();
  const existingStr = existing.toString().toLowerCase();
  const isZero = /^(0x)?(41)?0{40}$/.test(existingStr);
  // The contract itself allows replacement: scheduleUpgrade overwrites
  // scheduledImplementation and resets upgradeScheduledAt unconditionally. This
  // guard is a deliberate safety stop, not a contract limit. Prefer cancelling
  // first (TARGET=token scripts/tron-cancel-upgrade.ts) so the cleared state is an
  // auditable checkpoint; set REPLACE_PENDING=1 to overwrite in one call.
  if (!isZero) {
    if (process.env.REPLACE_PENDING !== "1") {
      throw new Error(
        `A pending schedule already exists: ${existingStr}\n` +
        `  Either cancel it first:\n` +
        `    TARGET=token EXECUTE=1 npx hardhat run scripts/tron-cancel-upgrade.ts --network tron\n` +
        `  or replace it in one call:\n` +
        `    REPLACE_PENDING=1 IMPL=${newImpl} npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron`,
      );
    }
    console.warn(`\n⚠ REPLACING pending schedule ${existingStr} — the 48h clock restarts from now.\n`);
  }

  console.log(`\nCalling scheduleUpgrade(${newImpl})...`);
  const tx = await proxyContract.scheduleUpgrade(newImpl).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: true,
  });
  console.log(`  ✓ scheduled, tx: ${tx}`);

  // Post check
  const after = await proxyContract.scheduledImplementation().call();
  const at = await proxyContract.upgradeScheduledAt().call();
  console.log(`\nPost-schedule state:`);
  console.log(`  scheduledImpl:           ${after}`);
  console.log(`  scheduledAt (unix):      ${at}`);
  console.log(`  UPGRADE_DELAY (seconds): ${delay}`);
  const executableAt = Number(at) + delay;
  console.log(`  executable after (unix): ${executableAt}`);
  console.log(`  human:                   ${new Date(executableAt * 1000).toISOString()}`);
  console.log(`\nNext: wait 48 hours, then run:`);
  console.log(`  npx hardhat run scripts/tron-execute-idrp-upgrade.ts --network tron`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

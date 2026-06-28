/**
 * Tron mainnet-specific: schedule v2 -> v3 upgrade of the IDRPController.
 * Mirror of nile-schedule-controller-upgrade.ts.
 *
 * Caller MUST be the current upgrader() of the proxy. If multisig, propose
 * via TronLink/TronScan instead.
 *
 * ⚠ MAINNET: real TRX is spent. Confirm before running.
 *
 * Usage:
 *   IMPL=0x... npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error(`Tron MAINNET only (got ${hre.network.name})`);
  }
  const newImpl = process.env.IMPL;
  if (!newImpl || !/^0x[0-9a-fA-F]{40}$/.test(newImpl)) {
    throw new Error("Set IMPL=0x... to the v3 implementation address from tron-deploy-controller-v3-impl.ts");
  }

  const { vars } = require("hardhat/config");
  const deployerPk = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const cleanedPk = deployerPk.startsWith("0x") ? deployerPk.slice(2) : deployerPk;
  const tronWeb = new TronWeb({
    fullHost: "https://api.trongrid.io",
    privateKey: cleanedPk,
  });

  const deployerT = tronWeb.address.fromPrivateKey(cleanedPk);
  // Tron mainnet Controller proxy from deployment/tron/mainnet.json
  const proxyT = "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX";
  console.log(`Network:     ${hre.network.name} (TRON MAINNET)`);
  console.log(`Deployer:    ${deployerT}`);
  console.log(`Proxy:       ${proxyT}`);
  console.log(`New v3 impl: ${newImpl}`);

  const abi = [
    {"inputs":[],"name":"upgrader","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"newImpl","type":"address"}],"name":"scheduleUpgrade","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[],"name":"scheduledImplementation","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"upgradeScheduledAt","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"UPGRADE_DELAY","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  ];
  const proxy = await tronWeb.contract(abi, proxyT);

  // Pre-flight
  const upgrader = await proxy.upgrader().call();
  const upgraderHex = "0x" + upgrader.toString().toLowerCase().slice(2);
  const deployerHex = ("0x" + tronWeb.address.toHex(deployerT).slice(2)).toLowerCase();
  console.log(`upgrader (hex): ${upgraderHex}`);
  if (upgraderHex !== deployerHex) {
    throw new Error(
      `Caller ${deployerHex} != upgrader ${upgraderHex}.\n` +
      `If the upgrader is a multisig, propose the scheduleUpgrade tx via TronLink/TronScan instead.`
    );
  }

  // 48h timelock sanity check.
  const delay = Number(await proxy.UPGRADE_DELAY().call());
  if (delay !== 48 * 3600) {
    console.warn(`⚠ UPGRADE_DELAY is ${delay} sec (${delay / 3600} h), expected 172800 (48 h).`);
    console.warn(`  This is mainnet. Aborting. Set FORCE_DELAY_OK=1 to override.`);
    if (process.env.FORCE_DELAY_OK !== "1") {
      process.exit(1);
    }
  }

  const existing = await proxy.scheduledImplementation().call();
  const existingStr = existing.toString().toLowerCase();
  const isZero = /^(0x)?(41)?0{40}$/.test(existingStr);
  if (!isZero) throw new Error(`Pending schedule exists: ${existingStr}`);

  console.log(`\nCalling scheduleUpgrade(${newImpl})...`);
  const tx = await proxy.scheduleUpgrade(newImpl).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: true,
  });
  console.log(`  ✓ scheduled, tx: ${tx}`);

  const after = await proxy.scheduledImplementation().call();
  const at = await proxy.upgradeScheduledAt().call();
  console.log(`\nPost-schedule:`);
  console.log(`  scheduledImpl:           ${after}`);
  console.log(`  scheduledAt (unix):      ${at}`);
  console.log(`  UPGRADE_DELAY (seconds): ${delay}`);
  console.log(`  executable after (unix): ${Number(at) + delay}`);
  console.log(`  human:                   ${new Date((Number(at) + delay) * 1000).toISOString()}`);
  console.log(`\nNext: wait 48 hours, then run:`);
  console.log(`  npx hardhat run scripts/tron-execute-controller-upgrade.ts --network tron`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

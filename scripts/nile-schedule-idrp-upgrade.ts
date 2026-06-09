/**
 * Nile-specific: schedule the v2 -> v3 upgrade of the IDRP proxy via TronWeb.
 *
 * Uses TronWeb directly (not ethers/hardhat) because Tron RPC doesn't support
 * eth_getTransactionCount or eth_estimateGas, which are what
 * hardhat-ethers signers rely on.
 *
 * Caller MUST be the current upgrader of the proxy.
 *
 * Usage:
 *   IMPL=0x... npx hardhat run scripts/nile-schedule-idrp-upgrade.ts --network nile
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

async function main() {
  if (hre.network.name !== "nile") {
    throw new Error(`This script is for nile testnet (got ${hre.network.name})`);
  }
  const newImpl = process.env.IMPL;
  if (!newImpl || !/^0x[0-9a-fA-F]{40}$/.test(newImpl)) {
    throw new Error("Set IMPL=0x... to the v3 implementation address");
  }

  const { vars } = require("hardhat/config");
  const deployerPk = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const cleanedPk = deployerPk.startsWith("0x") ? deployerPk.slice(2) : deployerPk;

  const tronWeb = new TronWeb({
    fullHost: "https://nile.trongrid.io",
    privateKey: cleanedPk,
  });

  const deployerAddress = tronWeb.address.fromPrivateKey(cleanedPk);
  console.log(`Deployer (T):     ${deployerAddress}`);
  console.log(`Deployer (hex):   0x${tronWeb.address.toHex(deployerAddress).slice(2)}`);

  // Nile IDRP proxy in T-format
  const proxyT = "TYdq9kGJQDSVxPeKH1zyXMuTgKK56tv1GU";
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

  // Pre-flight: check upgrader() on chain matches deployer
  const currentUpgrader = await proxyContract.upgrader().call();
  const currentUpgraderHex = "0x" + currentUpgrader.toString().toLowerCase().slice(2);
  const deployerHex = ("0x" + tronWeb.address.toHex(deployerAddress).slice(2)).toLowerCase();
  console.log(`upgrader() on-chain (hex): ${currentUpgraderHex}`);
  console.log(`deployer            (hex): ${deployerHex}`);
  if (currentUpgraderHex !== deployerHex) {
    throw new Error(`Caller ${deployerHex} is not the current upgrader ${currentUpgraderHex}`);
  }

  // Check no existing pending schedule. Tron addresses are returned with
  // a 0x41 prefix; zero address is "410000000000000000000000000000000000000000".
  const existing = await proxyContract.scheduledImplementation().call();
  const existingStr = existing.toString().toLowerCase();
  const isZero = /^(0x)?(41)?0{40}$/.test(existingStr);
  if (!isZero) {
    throw new Error(`A pending schedule already exists: ${existingStr}. Cancel first.`);
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
  const delay = await proxyContract.UPGRADE_DELAY().call();
  console.log(`\nPost-schedule state:`);
  console.log(`  scheduledImpl:           ${after}`);
  console.log(`  scheduledAt (unix):      ${at}`);
  console.log(`  UPGRADE_DELAY (seconds): ${delay}`);
  const executableAt = Number(at) + Number(delay);
  console.log(`  executable after (unix): ${executableAt}`);
  console.log(`  human:                   ${new Date(executableAt * 1000).toISOString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

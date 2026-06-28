/**
 * Tron mainnet-specific: execute the scheduled v2 -> v3 upgrade of the IDRP
 * proxy.
 *
 * Calls upgradeToAndCall(scheduledImpl, encoded_initializeV3) atomically,
 * which:
 *   1. swaps the proxy's implementation pointer to the new v3 impl
 *   2. delegate-calls initializeV3(admin, controller, upgrader) on the new impl
 *
 * Must be called by the current upgrader after the 48h timelock elapses.
 *
 * initializeV3 args (defaults; override via env vars):
 *   _admin       — IDRP_V3_ADMIN, default deployer T-address (= current upgrader)
 *   _controller  — IDRP_V3_CONTROLLER, default Tron mainnet Controller proxy
 *   _upgrader    — IDRP_V3_UPGRADER, default deployer T-address
 *
 * Mainnet vs Nile differences:
 *   - fullHost is api.trongrid.io.
 *   - Proxy address from deployment/tron/mainnet.json.
 *   - 48-HOUR timelock — the timelock check is enforced on-chain, this
 *     script also pre-flights it.
 *   - ⚠ Set IDRP_V3_ADMIN and IDRP_V3_UPGRADER to the intended multisig
 *     addresses unless you really want the deployer EOA as admin forever.
 *     For Nile we used the deployer as a convenience for testing; on
 *     mainnet the admin/upgrader should generally be a multisig.
 *
 * ⚠ MAINNET: real TRX is spent. Confirm before running.
 *
 * Usage:
 *   IDRP_V3_ADMIN=T... IDRP_V3_UPGRADER=T... \
 *     npx hardhat run scripts/tron-execute-idrp-upgrade.ts --network tron
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

async function main() {
  if (hre.network.name !== "tron") {
    throw new Error(`Tron MAINNET only (got ${hre.network.name})`);
  }
  const { vars } = require("hardhat/config");
  const deployerPk = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const cleanedPk = deployerPk.startsWith("0x") ? deployerPk.slice(2) : deployerPk;
  const tronWeb = new TronWeb({
    fullHost: "https://api.trongrid.io",
    privateKey: cleanedPk,
  });

  const proxyT = "TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r";
  const deployerT = tronWeb.address.fromPrivateKey(cleanedPk);
  console.log(`Network:  ${hre.network.name} (TRON MAINNET)`);
  console.log(`Deployer: ${deployerT}`);
  console.log(`Proxy:    ${proxyT}`);

  // Read scheduled impl + check timelock
  const proxyAbi = [
    {"inputs":[],"name":"scheduledImplementation","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"upgradeScheduledAt","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"UPGRADE_DELAY","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"newImpl","type":"address"},{"name":"data","type":"bytes"}],"name":"upgradeToAndCall","outputs":[],"stateMutability":"payable","type":"function"},
  ];
  const proxy = await tronWeb.contract(proxyAbi, proxyT);

  const scheduled = (await proxy.scheduledImplementation().call()).toString();
  if (/^(0x)?(41)?0{40}$/.test(scheduled.toLowerCase())) {
    throw new Error("No scheduled implementation.");
  }
  // Convert "41…" tron-format hex to "0x…" EVM hex
  const scheduledImplHex = "0x" + scheduled.toLowerCase().replace(/^(0x)?41/, "");
  console.log(`scheduledImpl: ${scheduledImplHex}`);

  const at = Number(await proxy.upgradeScheduledAt().call());
  const delay = Number(await proxy.UPGRADE_DELAY().call());
  const executableAt = at + delay;
  const now = Math.floor(Date.now() / 1000);
  const remaining = executableAt - now;
  console.log(`scheduledAt:       ${at} (${new Date(at * 1000).toISOString()})`);
  console.log(`UPGRADE_DELAY:     ${delay} sec`);
  console.log(`executable after:  ${executableAt} (${new Date(executableAt * 1000).toISOString()})`);
  console.log(`remaining (sec):   ${remaining}`);
  if (remaining > 0) {
    const hrs = Math.ceil(remaining / 3600);
    throw new Error(`Timelock not yet expired. Wait ${hrs} more hours.`);
  }
  if (delay !== 48 * 3600) {
    console.warn(`⚠ UPGRADE_DELAY is ${delay} sec, expected 172800 (48 h).`);
    console.warn(`  This is mainnet. Aborting. Set FORCE_DELAY_OK=1 to override.`);
    if (process.env.FORCE_DELAY_OK !== "1") {
      process.exit(1);
    }
  }

  // initializeV3 args
  const adminT = process.env.IDRP_V3_ADMIN ?? deployerT;
  // Default controller: Tron mainnet Controller proxy from deployment/tron/mainnet.json
  const controllerT = process.env.IDRP_V3_CONTROLLER ?? "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX";
  const upgraderT = process.env.IDRP_V3_UPGRADER ?? deployerT;
  const adminHex = "0x" + tronWeb.address.toHex(adminT).slice(2);
  const controllerHex = "0x" + tronWeb.address.toHex(controllerT).slice(2);
  const upgraderHex = "0x" + tronWeb.address.toHex(upgraderT).slice(2);
  console.log(`\ninitializeV3 args:`);
  console.log(`  _admin:      ${adminT} (${adminHex})`);
  console.log(`  _controller: ${controllerT} (${controllerHex})`);
  console.log(`  _upgrader:   ${upgraderT} (${upgraderHex})`);

  if (adminT === deployerT) {
    console.warn(`⚠ _admin defaults to deployer EOA. Did you mean to pass IDRP_V3_ADMIN=<multisig>?`);
  }
  if (upgraderT === deployerT) {
    console.warn(`⚠ _upgrader defaults to deployer EOA. Did you mean to pass IDRP_V3_UPGRADER=<multisig>?`);
  }

  // Encode initializeV3 calldata via ethers
  const { ethers } = hre;
  const iface = new ethers.Interface([
    "function initializeV3(address _admin, address _controller, address _upgrader)",
  ]);
  const initData = iface.encodeFunctionData("initializeV3", [
    adminHex,
    controllerHex,
    upgraderHex,
  ]);
  console.log(`initializeV3 calldata: ${initData}`);

  console.log(`\nCalling upgradeToAndCall(${scheduledImplHex}, initializeV3(...))...`);
  const tx = await proxy.upgradeToAndCall(scheduledImplHex, initData).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: true,
  });
  console.log(`  ✓ executed, tx: ${tx}`);

  // Post check via raw view calls on v3 selectors
  const v3Abi = [
    {"inputs":[],"name":"admin","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"controller","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"upgrader","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"scheduledImplementation","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
  ];
  const v3 = await tronWeb.contract(v3Abi, proxyT);
  console.log(`\nPost-upgrade v3 state:`);
  console.log(`  admin():               ${await v3.admin().call()}`);
  console.log(`  controller():          ${await v3.controller().call()}`);
  console.log(`  upgrader():            ${await v3.upgrader().call()}`);
  console.log(`  scheduledImpl:         ${await v3.scheduledImplementation().call()} (should be zero)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

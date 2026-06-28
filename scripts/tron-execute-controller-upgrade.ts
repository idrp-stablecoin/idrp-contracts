/**
 * Tron mainnet-specific: execute the scheduled v2 -> v3 upgrade of the
 * IDRPController.
 *
 * Calls upgradeToAndCall(scheduledImpl, encoded_initializeV3) atomically.
 *
 * Controller initializeV3 signature:
 *   initializeV3(address _admin, address _upgrader,
 *                address[] _legacyDefaultAdminHolders)
 *
 * The legacy DAR holders on mainnet Controller MUST be enumerated on-chain
 * before running this script. On Nile we found a single holder (the
 * multisig). On mainnet, list every address that ever received
 * DEFAULT_ADMIN_ROLE so the revoke-then-init pattern leaves exactly one
 * holder after ACDAR init.
 *
 * To enumerate, run scripts/list-default-admin-holders.ts --network tron
 * (replays RoleGranted/RoleRevoked events). Save the result to
 * CTRL_V3_LEGACY_DAR_HOLDERS as a comma-separated T-format list and pass
 * it in via env var.
 *
 * ⚠ MAINNET: real TRX is spent. Confirm before running.
 *
 * Usage:
 *   CTRL_V3_ADMIN=T... CTRL_V3_UPGRADER=T... \
 *     CTRL_V3_LEGACY_DAR_HOLDERS=T...,T... \
 *     npx hardhat run scripts/tron-execute-controller-upgrade.ts --network tron
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

  const proxyT = "TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX";
  const deployerT = tronWeb.address.fromPrivateKey(cleanedPk);
  console.log(`Network:  ${hre.network.name} (TRON MAINNET)`);
  console.log(`Deployer: ${deployerT}`);
  console.log(`Proxy:    ${proxyT}`);

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
  const scheduledImplHex = "0x" + scheduled.toLowerCase().replace(/^(0x)?41/, "");
  console.log(`scheduledImpl: ${scheduledImplHex}`);

  const at = Number(await proxy.upgradeScheduledAt().call());
  const delay = Number(await proxy.UPGRADE_DELAY().call());
  const executableAt = at + delay;
  const now = Math.floor(Date.now() / 1000);
  const remaining = executableAt - now;
  console.log(`scheduledAt:       ${at} (${new Date(at * 1000).toISOString()})`);
  console.log(`executable after:  ${new Date(executableAt * 1000).toISOString()}`);
  console.log(`remaining (sec):   ${remaining}`);
  if (remaining > 0) {
    throw new Error(`Timelock not yet expired. Wait ${Math.ceil(remaining / 3600)} more hours.`);
  }
  if (delay !== 48 * 3600) {
    console.warn(`⚠ UPGRADE_DELAY is ${delay} sec, expected 172800 (48 h).`);
    console.warn(`  This is mainnet. Aborting. Set FORCE_DELAY_OK=1 to override.`);
    if (process.env.FORCE_DELAY_OK !== "1") {
      process.exit(1);
    }
  }

  // initializeV3 args
  const adminT = process.env.CTRL_V3_ADMIN ?? deployerT;
  const upgraderT = process.env.CTRL_V3_UPGRADER ?? deployerT;

  // Legacy DAR holders — required input on mainnet. Must be enumerated via
  // scripts/list-default-admin-holders.ts before running this script.
  const legacyDARRaw = process.env.CTRL_V3_LEGACY_DAR_HOLDERS;
  if (!legacyDARRaw) {
    throw new Error(
      "CTRL_V3_LEGACY_DAR_HOLDERS is required.\n" +
      "Run: npx hardhat run scripts/list-default-admin-holders.ts --network tron\n" +
      "Pass the result as: CTRL_V3_LEGACY_DAR_HOLDERS=T...,T..."
    );
  }
  const legacyDARHoldersT = legacyDARRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (legacyDARHoldersT.length === 0) {
    throw new Error("CTRL_V3_LEGACY_DAR_HOLDERS parsed to empty list.");
  }

  const adminHex = "0x" + tronWeb.address.toHex(adminT).slice(2);
  const upgraderHex = "0x" + tronWeb.address.toHex(upgraderT).slice(2);
  const legacyDARHoldersHex = legacyDARHoldersT.map(
    (t: string) => "0x" + tronWeb.address.toHex(t).slice(2)
  );
  console.log(`\ninitializeV3 args:`);
  console.log(`  _admin:                     ${adminT}`);
  console.log(`  _upgrader:                  ${upgraderT}`);
  console.log(`  _legacyDefaultAdminHolders: [${legacyDARHoldersT.join(", ")}]`);

  if (adminT === deployerT) {
    console.warn(`⚠ _admin defaults to deployer EOA. Did you mean to pass CTRL_V3_ADMIN=<multisig>?`);
  }
  if (upgraderT === deployerT) {
    console.warn(`⚠ _upgrader defaults to deployer EOA. Did you mean to pass CTRL_V3_UPGRADER=<multisig>?`);
  }

  const { ethers } = hre;
  const iface = new ethers.Interface([
    "function initializeV3(address _admin, address _upgrader, address[] _legacyDefaultAdminHolders)",
  ]);
  const initData = iface.encodeFunctionData("initializeV3", [
    adminHex,
    upgraderHex,
    legacyDARHoldersHex,
  ]);
  console.log(`initializeV3 calldata: ${initData}`);

  console.log(`\nCalling upgradeToAndCall(${scheduledImplHex}, initializeV3(...))...`);
  const tx = await proxy.upgradeToAndCall(scheduledImplHex, initData).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: true,
  });
  console.log(`  ✓ executed, tx: ${tx}`);

  const v3Abi = [
    {"inputs":[],"name":"defaultAdmin","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"upgrader","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"scheduledImplementation","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
  ];
  const v3 = await tronWeb.contract(v3Abi, proxyT);
  console.log(`\nPost-upgrade Controller v3 state:`);
  console.log(`  defaultAdmin():    ${await v3.defaultAdmin().call()}`);
  console.log(`  upgrader():        ${await v3.upgrader().call()}`);
  console.log(`  scheduledImpl:     ${await v3.scheduledImplementation().call()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

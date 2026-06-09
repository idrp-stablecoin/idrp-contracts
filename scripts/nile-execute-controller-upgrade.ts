/**
 * Nile-specific: execute the scheduled v2 -> v3 upgrade of the IDRPController.
 *
 * Calls upgradeToAndCall(scheduledImpl, encoded_initializeV3) atomically.
 *
 * Controller initializeV3 signature:
 *   initializeV3(address _admin, address _upgrader, address[] _legacyDefaultAdminHolders)
 *
 * The legacy DAR holders on Nile Controller are just the multisig (TFH...wsM),
 * per the V3-2 invariant (revoke-then-init pattern).
 *
 * Usage:
 *   npx hardhat run scripts/nile-execute-controller-upgrade.ts --network nile
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

async function main() {
  if (hre.network.name !== "nile") {
    throw new Error(`nile only (got ${hre.network.name})`);
  }
  const { vars } = require("hardhat/config");
  const deployerPk = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const cleanedPk = deployerPk.startsWith("0x") ? deployerPk.slice(2) : deployerPk;
  const tronWeb = new TronWeb({
    fullHost: "https://nile.trongrid.io",
    privateKey: cleanedPk,
  });

  const proxyT = "TWTjirsqPT6DGC63RMSAHGtb2NdzauiJWy";
  const deployerT = tronWeb.address.fromPrivateKey(cleanedPk);
  const multisigT = "TFHoEW6Y4oy4As2phvLhRWxHivRhcSMwsM";
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

  // initializeV3 args
  const adminT = process.env.CTRL_V3_ADMIN ?? deployerT;
  const upgraderT = process.env.CTRL_V3_UPGRADER ?? deployerT;
  const adminHex = "0x" + tronWeb.address.toHex(adminT).slice(2);
  const upgraderHex = "0x" + tronWeb.address.toHex(upgraderT).slice(2);
  // Legacy DAR holders on Nile Controller — yesterday's probe showed only
  // the multisig TFH...wsM holds DEFAULT_ADMIN_ROLE.
  const legacyDARHoldersT = [multisigT];
  const legacyDARHoldersHex = legacyDARHoldersT.map(
    (t: string) => "0x" + tronWeb.address.toHex(t).slice(2)
  );
  console.log(`\ninitializeV3 args:`);
  console.log(`  _admin:                     ${adminT}`);
  console.log(`  _upgrader:                  ${upgraderT}`);
  console.log(`  _legacyDefaultAdminHolders: [${legacyDARHoldersT.join(", ")}]`);

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

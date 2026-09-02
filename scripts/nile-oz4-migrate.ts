/**
 * OBSOLETE — kept only as a record of what was attempted.
 *
 * The repair implementation this drives (IDRPControllerNileRepair) has been deleted: the
 * Nile Controller's upgrade path is frozen, so nothing can be deployed to that proxy any
 * more and the script cannot run. See notes/incidents/LOCAL-SIMULATION-RESULTS.md.
 *
 * Nile ONLY — migrate the Controller proxy from the OZ5+gap implementation to the
 * OZ4 implementation, repairing the legacy Initializable slot on the way.
 *
 * WHY THE REPAIR STEP EXISTS
 *   The Nile proxy was recovered by calling `initialize()` while it ran an
 *   implementation built WITHOUT the 251-slot gap. That wrote `idrpToken` into slot 0 —
 *   the slot OZ 4.x uses for `Initializable`. Read as OZ4 it now yields
 *   `_initialized = 237` with a truthy `_initializing`, so any OZ4
 *   initializer/reinitializer reverts "Initializable: contract is already initialized".
 *   Confirmed by simulation. Both Tron MAINNET proxies still hold `0x01` there and do
 *   NOT need this step.
 *
 * SEQUENCE (each upgrade goes through scheduleUpgrade + the normal timelock)
 *   1. schedule + upgrade to IDRPControllerNileRepair   (empty init data)
 *   2. repairLegacyInitSlot()                            -> slot 0 = 1
 *   3. schedule + upgrade to the real OZ4 impl, atomically with initializeV3(...)
 *   4. verify: roles read from the legacy slot 101 should be VISIBLE again
 *
 * Step 4 is the point of the exercise: it demonstrates that under OZ4 the original v2
 * roles survive, so a mainnet OZ4 migration needs no role re-grant and no outage.
 *
 *   npx hardhat run scripts/nile-oz4-migrate.ts --network nile              # dry run
 *   EXECUTE=1 npx hardhat run scripts/nile-oz4-migrate.ts --network nile    # broadcast
 *
 * Env:
 *   REPAIR_IMPL   hex address of the deployed IDRPControllerNileRepair
 *   OZ4_IMPL      hex address of the deployed OZ4 IDRPController
 *                 (defaults to the one already deployed on Nile)
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const PROXY = "TWTjirsqPT6DGC63RMSAHGtb2NdzauiJWy";
const HOST = "https://nile.trongrid.io";
const OZ4_IMPL_DEFAULT = "0xd1aD64cC1E7681Be9cE6605EE8C925a5e214ae4f"; // TV5swm2CZciFZq9dbUEsdu9xcRw6yMD5wT

// Original v2 role holders — these live at legacy slot 101 and should reappear under OZ4.
const LEGACY_ROLES: Record<string, string[]> = {
  OFFICER_ROLE: ["0xabdaa2fa14d78b83d9dfa84d417dff9300d6eec3", "0xed28d6c2973c49fe83eca2302a703dd9c8e9dd9b"],
  MANAGER_ROLE: ["0xa06f190b4e65f084ed9917ef1fe30121792d8304"],
  DIRECTOR_ROLE: ["0x32f48dda37a30554163e30b62cfb98de50c2ed58"],
  COMMISSIONER_ROLE: ["0xadde3172cad70db46766e75076adcfcaaa6ac390"],
};
const LEGACY_DEFAULT_ADMIN = "0x3a5cb1052ca9fbcd7b92574439d837bc0df5fa4f";

async function main() {
  if (hre.network.name !== "nile") throw new Error(`Nile only (got ${hre.network.name})`);
  const EXECUTE = process.env.EXECUTE === "1";
  const repairImpl = process.env.REPAIR_IMPL;
  const oz4Impl = process.env.OZ4_IMPL ?? OZ4_IMPL_DEFAULT;
  if (!repairImpl) throw new Error("Set REPAIR_IMPL=<hex address of the deployed IDRPControllerNileRepair>");

  const { ethers } = hre;
  const { vars } = require("hardhat/config");
  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const me = tw.address.fromPrivateKey(pk);
  const roleHash = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));

  const abi = [
    { inputs: [{ name: "n", type: "address" }], name: "scheduleUpgrade", outputs: [], stateMutability: "nonpayable", type: "function" },
    { inputs: [{ name: "n", type: "address" }, { name: "d", type: "bytes" }], name: "upgradeToAndCall", outputs: [], stateMutability: "payable", type: "function" },
    { inputs: [], name: "repairLegacyInitSlot", outputs: [], stateMutability: "nonpayable", type: "function" },
    { inputs: [], name: "legacyInitSlot", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "upgrader", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "defaultAdmin", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "UPGRADE_DELAY", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "upgradeScheduledAt", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [{ name: "r", type: "bytes32" }, { name: "a", type: "address" }], name: "hasRole", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  ];
  const c = await tw.contract(abi, PROXY);

  console.log(`network : nile`);
  console.log(`proxy   : ${PROXY}`);
  console.log(`signer  : ${me}`);
  console.log(`repair  : ${repairImpl}`);
  console.log(`oz4     : ${oz4Impl}`);
  console.log(`mode    : ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

  const upgrader = (await c.upgrader().call()).toString();
  console.log(`upgrader(): ${upgrader}`);
  const delay = Number(await c.UPGRADE_DELAY().call());
  console.log(`UPGRADE_DELAY: ${delay}s\n`);

  if (!EXECUTE) {
    console.log("DRY RUN — would run, in order:");
    console.log(`  1. scheduleUpgrade(${repairImpl}) ; wait ${delay}s ; upgradeToAndCall(repair, "")`);
    console.log(`  2. repairLegacyInitSlot()   (slot 0: garbage -> 1)`);
    console.log(`  3. scheduleUpgrade(${oz4Impl}) ; wait ${delay}s ; upgradeToAndCall(oz4, initializeV3(...))`);
    console.log(`  4. verify the legacy slot-101 roles are visible again`);
    return;
  }

  const wait = async (s: number) => { console.log(`   …waiting ${s}s for the timelock`); await new Promise(r => setTimeout(r, s * 1000 + 15000)); };

  // ---- 1. move to the repair implementation (empty init data) ----
  console.log("STEP 1 — upgrade to the repair implementation");
  await c.scheduleUpgrade(repairImpl).send({ feeLimit: 200_000_000, shouldPollResponse: true });
  await wait(delay);
  await c.upgradeToAndCall(repairImpl, "0x").send({ feeLimit: 500_000_000, callValue: 0, shouldPollResponse: true });
  console.log(`   legacyInitSlot() before repair: ${(await c.legacyInitSlot().call()).toString()}`);

  // ---- 2. repair slot 0 ----
  console.log("STEP 2 — repairLegacyInitSlot()");
  await c.repairLegacyInitSlot().send({ feeLimit: 200_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, 10000));
  console.log(`   legacyInitSlot() after repair : ${(await c.legacyInitSlot().call()).toString()}  (expect 1)`);

  // ---- 3. atomic upgrade to the OZ4 implementation ----
  console.log("STEP 3 — atomic upgrade to the OZ4 implementation");
  const initData = new ethers.Interface(["function initializeV3(address,address,address[])"])
    .encodeFunctionData("initializeV3", [
      "0x" + tw.address.toHex(me).slice(2),
      "0x" + tw.address.toHex(me).slice(2),
      [LEGACY_DEFAULT_ADMIN],
    ]);
  await c.scheduleUpgrade(oz4Impl).send({ feeLimit: 200_000_000, shouldPollResponse: true });
  await wait(delay);
  await c.upgradeToAndCall(oz4Impl, initData).send({ feeLimit: 500_000_000, callValue: 0, shouldPollResponse: true });
  console.log("   ✓ upgraded");

  // ---- 4. the point of the exercise ----
  await new Promise(r => setTimeout(r, 10000));
  console.log("\nSTEP 4 — do the ORIGINAL v2 roles survive under OZ4?");
  let ok = 0, total = 0;
  for (const [role, accts] of Object.entries(LEGACY_ROLES)) {
    for (const a of accts) {
      total++;
      const has = await c.hasRole(roleHash(role), a).call();
      if (has) ok++;
      console.log(`   ${role.padEnd(18)} ${a.slice(0, 12)}… ${has ? "✓ VISIBLE" : "✗ missing"}`);
    }
  }
  console.log(`   -> ${ok}/${total} legacy roles visible without any re-grant`);
  console.log(`   defaultAdmin(): ${(await c.defaultAdmin().call()).toString()}`);
  console.log(`   upgrader()    : ${(await c.upgrader().call()).toString()}`);
}

main().then(() => process.exit(0)).catch(e => { console.error("\n✗", e.message || JSON.stringify(e)); process.exit(1); });

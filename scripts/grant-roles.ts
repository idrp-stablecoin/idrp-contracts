/**
 * 03_grant_roles.ts
 *
 * Run AFTER both contracts are deployed, using the ADMIN wallet
 * (TRON_ADMIN_ADDRESS private key in hardhat.config.ts accounts[]).
 *
 * What this script does:
 *  1. Grant CONTROLLER_ROLE on IDRP to IDRPController      [C-1 FIX]
 *  2. Grant MINTER_ROLE on IDRP to IDRPController          [allows mint/burn via controller]
 *  3. Grant PAUSER_ROLE on IDRP to IDRPController          [allows pause/unpause via controller]
 *  4. Grant FREEZER_ROLE on IDRP to IDRPController         [allows freeze/unfreeze via controller]
 *  5. Grant operational roles on IDRPController             [Officer, Manager, Director, Commissioner]
 *  6. Verify all roles
 *
 * Usage:
 *   npx hardhat run deploy/03_grant_roles.ts --network shasta
 *
 * NOTE: Switch private key in .env to TRON_ADMIN_ADDRESS before running.
 */

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  TRON_ADMIN_ADDRESS,
  TRON_OFFICER_ADDRESS,
  TRON_MANAGER_ADDRESS,
  TRON_DIRECTOR_ADDRESS,
  TRON_COMMISSIONER_ADDRESS,
} from "../scripts/utils/constants";
import { tronToHex } from "../scripts/utils/addressConverter";

// ─── Fill these after deployment ──────────────────────────────────────────────
// Or read automatically from hardhat-deploy artifacts:
const USE_ARTIFACTS = true; // set false to use hardcoded addresses below
const IDRP_PROXY_ADDRESS       = ""; // ← only used if USE_ARTIFACTS = false
const CONTROLLER_PROXY_ADDRESS = ""; // ← only used if USE_ARTIFACTS = false

async function main() {
  const hre: HardhatRuntimeEnvironment = require("hardhat");
  const [admin] = await ethers.getSigners();
  const adminAddress = await admin.getAddress();

  let idrpAddress: string;
  let controllerAddress: string;

  if (USE_ARTIFACTS) {
    const idrpDeploy       = await hre.deployments.get("IDRP");
    const controllerDeploy = await hre.deployments.get("IDRPController");
    idrpAddress       = idrpDeploy.address;
    controllerAddress = controllerDeploy.address;
  } else {
    if (!IDRP_PROXY_ADDRESS || !CONTROLLER_PROXY_ADDRESS) {
      throw new Error("Set IDRP_PROXY_ADDRESS and CONTROLLER_PROXY_ADDRESS, or enable USE_ARTIFACTS");
    }
    idrpAddress       = IDRP_PROXY_ADDRESS;
    controllerAddress = CONTROLLER_PROXY_ADDRESS;
  }

  console.log(`\n🔐 Grant Roles Script`);
  console.log(`   Signer (admin)        : ${adminAddress}`);
  console.log(`   IDRP Proxy            : ${idrpAddress}`);
  console.log(`   IDRPController Proxy  : ${controllerAddress}\n`);

  const idrp       = (await ethers.getContractAt("IDRP",           idrpAddress)).connect(admin);
  const controller = (await ethers.getContractAt("IDRPController", controllerAddress)).connect(admin);

  // ─── Verify admin has necessary roles ────────────────────────────────────
  const IDRP_DEFAULT_ADMIN = await idrp.DEFAULT_ADMIN_ROLE();
  const CTRL_ADMIN_ROLE    = await controller.ADMIN_ROLE();

  if (!(await idrp.hasRole(IDRP_DEFAULT_ADMIN, adminAddress))) {
    throw new Error(
      `❌ Signer ${adminAddress} does not have DEFAULT_ADMIN_ROLE on IDRP.\n` +
      `   Switch to admin wallet: ${TRON_ADMIN_ADDRESS}`
    );
  }
  if (!(await controller.hasRole(CTRL_ADMIN_ROLE, adminAddress))) {
    throw new Error(
      `❌ Signer ${adminAddress} does not have ADMIN_ROLE on IDRPController.\n` +
      `   Switch to admin wallet: ${TRON_ADMIN_ADDRESS}`
    );
  }
  console.log(`✓ Admin verified on both contracts\n`);

  // ─── Step 1: Grant IDRP roles to IDRPController ───────────────────────────
  console.log(`[1/3] Granting IDRP roles to IDRPController (${controllerAddress})...`);

  const idrpRolesToController: Array<{ name: string; getter: string }> = [
    { name: "CONTROLLER_ROLE", getter: "CONTROLLER_ROLE" }, // [C-1 FIX] upgrade auth
    { name: "MINTER_ROLE",     getter: "MINTER_ROLE"     }, // allows mint/burn
    { name: "PAUSER_ROLE",     getter: "PAUSER_ROLE"     }, // allows pause/unpause
    { name: "FREEZER_ROLE",    getter: "FREEZER_ROLE"    }, // allows freeze/unfreeze
  ];

  for (const { name, getter } of idrpRolesToController) {
    const roleHash = await (idrp as any)[getter]();
    if (await idrp.hasRole(roleHash, controllerAddress)) {
      console.log(`      ⏭  ${name} already granted`);
    } else {
      const tx = await idrp.grantRole(roleHash, controllerAddress);
      await tx.wait();
      console.log(`      ✓  ${name} → IDRPController`);
    }
  }

  // ─── Step 2: Grant operational roles on IDRPController ───────────────────
  console.log(`\n[2/3] Granting operational roles on IDRPController...`);

  const operationalRoles = [
    { name: "OFFICER_ROLE",      getter: "OFFICER_ROLE",      tron: TRON_OFFICER_ADDRESS },
    { name: "MANAGER_ROLE",      getter: "MANAGER_ROLE",      tron: TRON_MANAGER_ADDRESS },
    { name: "DIRECTOR_ROLE",     getter: "DIRECTOR_ROLE",     tron: TRON_DIRECTOR_ADDRESS },
    { name: "COMMISSIONER_ROLE", getter: "COMMISSIONER_ROLE", tron: TRON_COMMISSIONER_ADDRESS },
  ];

  for (const { name, getter, tron } of operationalRoles) {
    const hex      = tronToHex(tron);
    const roleHash = await (controller as any)[getter]();
    if (await controller.hasRole(roleHash, hex)) {
      console.log(`      ⏭  ${name} already granted to ${tron}`);
    } else {
      const tx = await controller.grantRole(roleHash, hex);
      await tx.wait();
      console.log(`      ✓  ${name} → ${hex} (${tron})`);
    }
  }

  // ─── Step 3: Verify all roles ─────────────────────────────────────────────
  console.log(`\n[3/3] Final role verification...\n`);

  const adminHex = tronToHex(TRON_ADMIN_ADDRESS);
  console.log(`IDRP roles:`);
  for (const { name, getter } of idrpRolesToController) {
    const roleHash = await (idrp as any)[getter]();
    console.log(`   ${name.padEnd(18)} → IDRPController : ${await idrp.hasRole(roleHash, controllerAddress)}`);
  }

  const MINTER  = await idrp.MINTER_ROLE();
  const PAUSER  = await idrp.PAUSER_ROLE();
  const FREEZER = await idrp.FREEZER_ROLE();
  console.log(`\n   Admin still has MINTER_ROLE  : ${await idrp.hasRole(MINTER,  adminHex)}`);
  console.log(`   Admin still has PAUSER_ROLE  : ${await idrp.hasRole(PAUSER,  adminHex)}`);
  console.log(`   Admin still has FREEZER_ROLE : ${await idrp.hasRole(FREEZER, adminHex)}`);

  console.log(`\nIDRPController operational roles:`);
  for (const { name, getter, tron } of operationalRoles) {
    const hex      = tronToHex(tron);
    const roleHash = await (controller as any)[getter]();
    console.log(`   ${name.padEnd(18)} → ${tron} : ${await controller.hasRole(roleHash, hex)}`);
  }

  console.log(`\n✅ All roles configured. System is ready.\n`);

  // ─── Optional: Tighten security by revoking direct MINTER/PAUSER from admin ─
  console.log(`⚠️  OPTIONAL SECURITY HARDENING:`);
  console.log(`   If mint/burn/pause/unpause should ONLY go through IDRPController`);
  console.log(`   (recommended for production), revoke these from admin:`);
  console.log(`     idrp.revokeRole(MINTER_ROLE,  adminAddress)`);
  console.log(`     idrp.revokeRole(PAUSER_ROLE,  adminAddress)`);
  console.log(`     idrp.revokeRole(FREEZER_ROLE, adminAddress)`);
  console.log(`   After revoking, all operations require controller multisig.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/v1-to-v2/validate.ts
 *
 * Pre-flight check for the testnet v1 → v2 migration. Performs the OZ
 * Upgrades plugin's `validateUpgrade` for both IDRP and IDRPController
 * against the legacy v2 sources in contracts/legacy/. No state-changing
 * calls — read-only.
 *
 * Exits with non-zero status on any failure. Run this BEFORE any
 * prepare-upgrade or upgrade script.
 *
 * Usage:
 *   npx hardhat run scripts/v1-to-v2/validate.ts --network <testnet>
 */

async function main() {
  const networkName = hre.network.name;
  const networkId = hre.network.config.chainId ?? 0;
  console.log(`Network: ${networkName} (chainId ${networkId})\n`);

  const deploymentFile = path.join(
    hre.config.paths.root,
    "deployment",
    `chain-${networkId}.json`
  );
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  const idrpAddr = deployments.IDRP;
  const ctrlAddr = deployments.IDRPController;

  let anyFailure = false;

  if (idrpAddr) {
    await validateOne({
      label: "IDRP",
      proxyAddress: idrpAddr,
      legacyFactoryName: "IDRPv2",
      probeSelector: "0xaf269745", // upgrader()
    }).catch((e) => {
      console.error(`  ✗ IDRP validation failed: ${(e as Error).message}`);
      anyFailure = true;
    });
  } else {
    console.log("IDRP: no proxy address in deployment file — skipping\n");
  }

  if (ctrlAddr) {
    await validateOne({
      label: "IDRPController",
      proxyAddress: ctrlAddr,
      legacyFactoryName: "IDRPControllerv2",
      probeSelector: "0xaf269745", // upgrader()
    }).catch((e) => {
      console.error(
        `  ✗ IDRPController validation failed: ${(e as Error).message}`
      );
      anyFailure = true;
    });
  } else {
    console.log("IDRPController: no proxy address in deployment file — skipping\n");
  }

  if (anyFailure) {
    process.exitCode = 1;
    console.error("\nOne or more validations failed. Do NOT proceed.");
    return;
  }
  console.log("All validations passed. Safe to proceed to prepare-upgrade.");
}

async function validateOne(args: {
  label: string;
  proxyAddress: string;
  legacyFactoryName: string;
  probeSelector: string;
}): Promise<void> {
  const { label, proxyAddress, legacyFactoryName, probeSelector } = args;
  console.log(`─── ${label} ───`);
  console.log(`  proxy:           ${proxyAddress}`);

  const code = await hre.ethers.provider.getCode(proxyAddress);
  if (code === "0x" || code === "0x0") {
    throw new Error(`No code at proxy address — wrong chain?`);
  }

  // Surface probe: confirm `upgrader()` reverts (i.e. proxy is at v1).
  let upgraderResult: { ok: true; addr: string } | { ok: false };
  try {
    const raw = await hre.ethers.provider.call({
      to: proxyAddress,
      data: probeSelector,
    });
    upgraderResult = {
      ok: true,
      addr: hre.ethers.getAddress("0x" + raw.slice(-40)),
    };
  } catch {
    upgraderResult = { ok: false };
  }

  if (upgraderResult.ok) {
    console.log(
      `  upgrader():       ${upgraderResult.addr}  ← already populated`
    );
    throw new Error(
      `This proxy is NOT at v1 (upgrader is already set). The v1→v2 migration is only for v1 proxies. Run scripts/check-contract-state.ts for full state, and use the top-level scripts/upgrade.ts for any v2+ upgrades.`
    );
  }
  console.log(`  upgrader():       REVERT  ← confirms v1 state`);

  // OZ-plugin layout check against the legacy contract we'd deploy.
  console.log(`  validateUpgrade vs contracts/legacy/${legacyFactoryName}.sol …`);
  const LegacyFactory = await hre.ethers.getContractFactory(legacyFactoryName);
  await hre.upgrades.validateUpgrade(proxyAddress, LegacyFactory, {
    kind: "uups",
    unsafeAllow: ["missing-initializer-call"],
  });
  console.log(`  ✓ Storage layout is upgrade-safe.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

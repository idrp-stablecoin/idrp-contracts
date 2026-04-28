import fs from "fs";
import path from "path";
import hre from "hardhat";
import { Interface } from "ethers";
import { ADMIN_ADDRESS } from "./utils/constants";

/**
 * Verifies IDRP and IDRPController contracts on a block explorer.
 *
 * Usage:
 *   npx hardhat run scripts/verify.ts --network <network>
 *
 * Supported networks: mainnet, polygon, bsc, holesky, sepolia, baseSepolia, kairos
 *
 * Both the proxy (ERC1967Proxy) and its implementation are verified.
 * Errors from already-verified contracts are silently ignored.
 */

// ── Fully-qualified contract names ───────────────────────────────────────────
const IDRP_CONTRACT = "contracts/IDRP.sol:IDRP";
const IDRP_CONTROLLER_CONTRACT = "contracts/IDRPController.sol:IDRPController";
const ERC1967_PROXY_CONTRACT =
  "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

/**
 * Set to true if the contracts were compiled with viaIR: true.
 * When enabled, the compiler setting is injected into the Hardhat config
 * before each verify call so the explorer receives the correct metadata.
 */
const VIA_IR = false;

interface VerifyOptions {
  /** Fully-qualified contract name, e.g. "contracts/IDRP.sol:IDRP" */
  contract?: string;
  /**
   * Override the viaIR compiler setting for this specific verification.
   * Defaults to the module-level VIA_IR constant.
   */
  viaIR?: boolean;
}

function applyViaIR(enabled: boolean): void {
  // hardhat.config shape used here: solidity: { version, settings: { ... } }
  const solidity = hre.config.solidity as {
    settings?: Record<string, unknown>;
    compilers?: Array<{ settings?: Record<string, unknown> }>;
  };

  if (solidity.settings) {
    solidity.settings.viaIR = enabled || undefined;
  }
  if (solidity.compilers) {
    for (const compiler of solidity.compilers) {
      if (compiler.settings) {
        compiler.settings.viaIR = enabled || undefined;
      }
    }
  }
}

async function verifyContract(
  label: string,
  address: string,
  constructorArguments: unknown[],
  options: VerifyOptions = {}
): Promise<void> {
  const { contract, viaIR = VIA_IR } = options;

  console.log(`\nVerifying ${label}...`);
  console.log(`  Address  : ${address}`);
  if (contract) {
    console.log(`  Contract : ${contract}`);
  }
  console.log(`  viaIR    : ${viaIR}`);
  if (constructorArguments.length) {
    console.log(`  Ctor args: ${JSON.stringify(constructorArguments)}`);
  }

  applyViaIR(viaIR);

  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log(`  ✓ ${label} verified`);
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    if (
      msg.includes("Already Verified") ||
      msg.includes("already verified") ||
      msg.includes("Contract source code already verified")
    ) {
      console.log(`  ✓ ${label} already verified`);
    } else {
      console.error(`  ✗ ${label} verification failed: ${msg}`);
    }
  }
}

async function main(): Promise<void> {
  // Tron networks don't have a chainId and use a different explorer — skip them
  if ((hre.network.config as Record<string, unknown>).tron === true) {
    throw new Error(
      `Network "${hre.network.name}" is a Tron network and does not support Etherscan-style verification.\n` +
        `Use TronScan (https://tronscan.org) to verify Tron contracts manually.`
    );
  }

  const networkId = hre.network.config.chainId;
  if (!networkId) {
    throw new Error(
      `Could not determine chainId for network "${hre.network.name}".\n` +
        `Make sure you pass --network <name>, e.g.:\n` +
        `  npx hardhat run scripts/verify.ts --network polygon`
    );
  }

  const deploymentFile = path.join(
    hre.config.paths.root || process.cwd(),
    "deployment",
    `chain-${networkId}.json`
  );

  if (!fs.existsSync(deploymentFile)) {
    throw new Error(
      `Deployment file not found: ${deploymentFile}\n` +
        `Run the deploy script first.`
    );
  }

  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );

  console.log(`\n=== Contract Verification ===`);
  console.log(`Network   : ${hre.network.name} (chainId ${networkId})`);
  console.log(`Deployments:`);
  Object.entries(deployments).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  // ── IDRP ──────────────────────────────────────────────────────────────────
  const idrpProxy = deployments["IDRP"];
  if (idrpProxy) {
    // Resolve the implementation address from the ERC1967 storage slot
    const idrpImpl =
      await hre.upgrades.erc1967.getImplementationAddress(idrpProxy);
    console.log(`\nIDRP proxy       : ${idrpProxy}`);
    console.log(`IDRP impl        : ${idrpImpl}`);

    // Verify implementation (no constructor – uses initializer)
    await verifyContract("IDRP (implementation)", idrpImpl, [], {
      contract: IDRP_CONTRACT,
    });

    // Verify proxy (ERC1967Proxy constructor: logic, data)
    const idrpIface = new Interface([
      "function initialize(address superAdmin)",
    ]);
    const idrpInitData = idrpIface.encodeFunctionData("initialize", [
      ADMIN_ADDRESS,
    ]);

    await verifyContract("IDRP (proxy)", idrpProxy, [idrpImpl, idrpInitData], {
      contract: ERC1967_PROXY_CONTRACT,
    });
  } else {
    console.log("\nNo IDRP deployment found – skipping.");
  }

  // ── IDRPController ────────────────────────────────────────────────────────
  const controllerProxy = deployments["IDRPController"];
  if (controllerProxy) {
    const controllerImpl =
      await hre.upgrades.erc1967.getImplementationAddress(controllerProxy);
    console.log(`\nIDRPController proxy : ${controllerProxy}`);
    console.log(`IDRPController impl  : ${controllerImpl}`);

    // Verify implementation (no constructor – uses initializer)
    await verifyContract(
      "IDRPController (implementation)",
      controllerImpl,
      [],
      { contract: IDRP_CONTROLLER_CONTRACT }
    );

    // Verify proxy – initializer was: initialize(idrpToken, safeAddress)
    // safeAddress defaults to ADMIN_ADDRESS (see deploy-controller.ts)
    const controllerIface = new Interface([
      "function initialize(address idrpToken, address safeAddress)",
    ]);
    const controllerInitData = controllerIface.encodeFunctionData(
      "initialize",
      [idrpProxy ?? deployments["IDRP"], ADMIN_ADDRESS]
    );

    await verifyContract(
      "IDRPController (proxy)",
      controllerProxy,
      [controllerImpl, controllerInitData],
      { contract: ERC1967_PROXY_CONTRACT }
    );
  } else {
    console.log("\nNo IDRPController deployment found – skipping.");
  }

  console.log("\n=== Done ===\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

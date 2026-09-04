import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import hre from "hardhat";

/**
 * Arms the Confiscate operation on a chain by seeding its quorum rules
 * (OperationType 6) on the Controller.
 *
 * That is now the ONLY setup step. Seized funds go to `depositoryWallet`, which
 * every live chain already has, so there is no destination to configure and no
 * 48h wait. Seeding these rules is the single act that arms seizure — treat it
 * with the weight that implies.
 *
 * Seeding is INSTANT: setQuorumRules requires quorumRules[op].length == 0, and
 * Confiscate is a new op type with no rules anywhere. Only a *change* to an
 * existing rule set goes through the schedule/apply timelock.
 *
 * Rules come from test/utils/rules.confiscate.json, the source of truth in
 * version control. Nothing on-chain keeps a deployed rule set in sync with that
 * file, so this script prints what it read and what is live.
 *
 * The admin on the testnets and in production is a Safe, which has no local
 * private key. When no configured signer holds DEFAULT_ADMIN_ROLE this script
 * prints Safe-ready transaction parameters instead of failing.
 *
 * Usage:
 *   npx hardhat run scripts/setup-confiscate.ts --network kairos
 *
 *   # mainnets additionally require ALLOW_MAINNET=1 (Rule 0: real on-chain
 *   # state — get explicit sign-off before running):
 *   ALLOW_MAINNET=1 npx hardhat run scripts/setup-confiscate.ts --network kaia
 *
 * Env:
 *   ALLOW_MAINNET=1  required ack to run against a mainnet chain id (1 / 56 / 137 / 8217).
 */

const CONFISCATE_OP = 6;
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

/** Chain ids that hold real value — require ALLOW_MAINNET=1 (Rule 0). */
const MAINNET_CHAIN_IDS = new Set([1, 56, 137, 8217]);

/** Refuses to continue against a mainnet chain id unless ALLOW_MAINNET=1 is set. */
function assertAllowedNetwork(chainId: number, networkName: string): void {
  if (MAINNET_CHAIN_IDS.has(chainId) && process.env.ALLOW_MAINNET !== "1") {
    throw new Error(
      `"${networkName}" (chainId ${chainId}) is a MAINNET — real on-chain state. ` +
        `Re-run with ALLOW_MAINNET=1 only after explicit sign-off (Rule 0).`,
    );
  }
}

type RuleJson = {
  minAmount: string;
  maxAmount: string;
  requiredRoles: string[];
};

async function main() {
  const chainId = hre.network.config.chainId;
  if (chainId === undefined) throw new Error("network has no chainId configured");

  assertAllowedNetwork(chainId, hre.network.name);

  const deploymentPath = path.join(__dirname, `../deployment/chain-${chainId}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`no deployment record at ${deploymentPath}`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const tokenAddress: string = deployment.IDRP;
  const controllerAddress: string = deployment.IDRPController;

  const token = await ethers.getContractAt("IDRP", tokenAddress);
  const controller = await ethers.getContractAt("IDRPController", controllerAddress);

  // ── Show the target before writing anything ────────────────────────────────
  const onChainAdmin = await token.admin();
  const depository = await token.depositoryWallet();

  console.log("network            ", hre.network.name, `(chainId ${chainId})`);
  console.log("token              ", tokenAddress);
  console.log("controller         ", controllerAddress);
  console.log("token.admin()      ", onChainAdmin);
  console.log("depositoryWallet   ", depository, "  <- seizure destination");

  // The depository is where seized funds land. A misconfigured one is not a
  // setup inconvenience, it is a permanent loss, so check it before arming.
  if (depository === ethers.ZeroAddress) {
    throw new Error(
      "depositoryWallet is unset — confiscate would revert. Set it before arming Confiscate.",
    );
  }
  if (depository.toLowerCase() === tokenAddress.toLowerCase()) {
    throw new Error(
      "depositoryWallet is the token contract — seized funds would be unrecoverable " +
        "(withdrawToken() refuses token == address(this)).",
    );
  }
  if (depository.toLowerCase() === controllerAddress.toLowerCase()) {
    throw new Error("depositoryWallet is the controller — seized funds would be stranded there.");
  }
  if (await token.frozen(depository)) {
    console.warn("\nWARNING: the depository is FROZEN. Seizures would still land there but be immobilized.");
  }

  // ── Seed the Confiscate quorum rules ───────────────────────────────────────
  const rulesPath = path.join(__dirname, "../test/utils/rules.confiscate.json");
  const rules: RuleJson[] = JSON.parse(fs.readFileSync(rulesPath, "utf8"));

  console.log(`\nrules.confiscate.json: ${rules.length} tier(s)`);
  rules.forEach((r, i) =>
    console.log(
      `  tier ${i}: [${r.minAmount}, ${r.maxAmount}) requires ${r.requiredRoles.length} role(s)`,
    ),
  );

  let alreadySeeded = false;
  try {
    await controller.getQuorumRule(CONFISCATE_OP, 0);
    alreadySeeded = true;
  } catch {
    // reverts "No matching quorum rule found" while unseeded
  }

  if (alreadySeeded) {
    const live = await controller.getQuorumRule(CONFISCATE_OP, 0);
    console.log("\nConfiscate rules already seeded — nothing to do.");
    console.log("live tier 0 requires", live.requiredRoles.length, "role(s)");
    console.log("\nConfiscate is ARMED on this chain.");
    return;
  }

  const args = [
    CONFISCATE_OP,
    rules.map((r) => ({
      minAmount: BigInt(r.minAmount),
      maxAmount: BigInt(r.maxAmount),
      requiredRoles: r.requiredRoles,
    })),
  ] as const;

  const signers = await ethers.getSigners();
  let sender: (typeof signers)[number] | undefined;
  for (const s of signers) {
    if (await controller.hasRole(DEFAULT_ADMIN_ROLE, s.address)) {
      sender = s;
      break;
    }
  }

  if (!sender) {
    // Expected on every network whose admin is a Safe. Emit the parameters to
    // paste into the Safe transaction builder rather than failing.
    const data = controller.interface.encodeFunctionData("setQuorumRules", args as any);
    console.log("\nNo configured signer holds DEFAULT_ADMIN_ROLE on the Controller.");
    console.log("Submit this from the admin Safe instead:\n");
    console.log("  to      ", controllerAddress);
    console.log("  value   ", "0");
    console.log("  operation", "0 (CALL — not DelegateCall)");
    console.log("  data    ", data);
    console.log(
      "\nSend it as a SINGLE transaction, not batched through MultiSend — a batched" +
        "\ninner revert surfaces only as GS013 and hides which call failed.",
    );
    return;
  }

  console.log("\nSeeding Confiscate quorum rules (instant, no timelock)...");
  console.log("signer             ", sender.address);
  const tx = await controller.connect(sender).setQuorumRules(...(args as any));
  await tx.wait();
  console.log("seeded:", tx.hash);

  const live = await controller.getQuorumRule(CONFISCATE_OP, 0);
  console.log("live tier 0 requires", live.requiredRoles.length, "role(s)");
  console.log("\nConfiscate is ARMED on this chain. Seizures land in", depository);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

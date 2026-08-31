import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import hre from "hardhat";

/**
 * Post-upgrade setup for the Confiscate operation.
 *
 *   1. Seeds the Confiscate quorum rules (OperationType 6) on the Controller.
 *   2. Schedules the token's confiscationWallet (48h timelock).
 *
 * Both steps are idempotent — re-running reports the existing state instead of
 * failing, so this is safe to run twice.
 *
 * Rules come from test/utils/rules.confiscate.json, which is the source of
 * truth in version control. Nothing on-chain keeps a deployed rule set in sync
 * with that file, so this script prints what it read and what is live.
 *
 * Seeding is INSTANT: setQuorumRules requires quorumRules[op].length == 0, and
 * Confiscate is a new op type with no rules anywhere. Only a *change* to an
 * existing rule set goes through the schedule/apply timelock.
 *
 * Usage:
 *   CONFISCATION_WALLET=0x... npx hardhat run scripts/setup-confiscate.ts --network kairos
 *
 *   # per-chain override, takes precedence over the generic var — useful when
 *   # one .env serves several networks:
 *   CONFISCATION_WALLET_1001=0x... npx hardhat run scripts/setup-confiscate.ts --network kairos
 *
 *   # mainnets additionally require ALLOW_MAINNET=1 (Rule 0: real on-chain
 *   # state — get explicit sign-off before running):
 *   CONFISCATION_WALLET=0x... ALLOW_MAINNET=1 npx hardhat run scripts/setup-confiscate.ts --network kaia
 *
 * Then, 48h after the schedule step:
 *   npx hardhat run scripts/apply-confiscation-wallet.ts --network kairos
 *
 * Env:
 *   CONFISCATION_WALLET            destination for seized funds. Must not be
 *                                   the depository, token, or controller address.
 *   CONFISCATION_WALLET_<chainId>  per-chain override, checked before the
 *                                   generic var above (e.g. CONFISCATION_WALLET_1001).
 *   ALLOW_MAINNET=1                required ack to run against a mainnet chain
 *                                   id (1 / 56 / 137 / 8217).
 */

const CONFISCATE_OP = 6;

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

/**
 * Destination for seized funds, read from the environment:
 *   CONFISCATION_WALLET_<chainId>  per-chain override, checked first
 *   CONFISCATION_WALLET            generic fallback used for every chain
 */
function resolveConfiscationWallet(chainId: number): string {
  const perChainVar = `CONFISCATION_WALLET_${chainId}`;
  const perChainValue = process.env[perChainVar];
  const destination = perChainValue || process.env.CONFISCATION_WALLET;
  const source = perChainValue ? perChainVar : "CONFISCATION_WALLET";

  if (!destination) {
    throw new Error(
      `No confiscation wallet configured for chain ${chainId}. Set ${perChainVar} ` +
        `(preferred) or CONFISCATION_WALLET in your environment before running this script.`,
    );
  }
  if (!ethers.isAddress(destination)) {
    throw new Error(`${source}="${destination}" is not a valid address`);
  }
  return destination;
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
  const destination = resolveConfiscationWallet(chainId);

  const signers = await ethers.getSigners();

  const token = await ethers.getContractAt("IDRP", tokenAddress);
  const controller = await ethers.getContractAt("IDRPController", controllerAddress);

  // ── Show the target before writing anything ────────────────────────────────
  const onChainAdmin = await token.admin();
  const onChainDepository = await token.depositoryWallet();

  // Both steps below are admin-gated, and the admin key differs per network —
  // resolve it from on-chain state rather than assuming a signer index.
  const admin = signers.find(
    (s) => s.address.toLowerCase() === onChainAdmin.toLowerCase(),
  );

  console.log("network            ", hre.network.name, `(chainId ${chainId})`);
  console.log("token              ", tokenAddress);
  console.log("controller         ", controllerAddress);
  console.log("signer             ", admin ? admin.address : "(none matched)");
  console.log("token.admin()      ", onChainAdmin);
  console.log("depositoryWallet   ", onChainDepository);
  console.log("confiscationWallet ", destination, "(to schedule)");

  if (!admin) {
    throw new Error(
      `None of the ${signers.length} configured signer(s) is token.admin() ` +
        `(${onChainAdmin}) on ${hre.network.name}. Available: ` +
        signers.map((s) => s.address).join(", "),
    );
  }
  if (destination.toLowerCase() === onChainDepository.toLowerCase()) {
    throw new Error(
      "confiscation wallet equals the depository — seized funds must never mix with reserves",
    );
  }
  if (
    destination.toLowerCase() === tokenAddress.toLowerCase() ||
    destination.toLowerCase() === controllerAddress.toLowerCase()
  ) {
    throw new Error(
      "confiscation wallet equals the token or controller address — funds sent there would be " +
        "unrecoverable (withdrawToken() refuses token == address(this))",
    );
  }

  // ── 1. Seed the Confiscate quorum rules ────────────────────────────────────
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
    console.log("\n[1/2] Confiscate rules already seeded — skipping.");
  } else {
    console.log("\n[1/2] Seeding Confiscate quorum rules (instant, no timelock)...");
    const tx = await controller.connect(admin).setQuorumRules(
      CONFISCATE_OP,
      rules.map((r) => ({
        minAmount: BigInt(r.minAmount),
        maxAmount: BigInt(r.maxAmount),
        requiredRoles: r.requiredRoles,
      })),
    );
    await tx.wait();
    console.log("      seeded:", tx.hash);
  }

  const live = await controller.getQuorumRule(CONFISCATE_OP, 0);
  console.log("      live tier 0 requires", live.requiredRoles.length, "role(s)");

  // ── 2. Schedule the confiscation wallet ────────────────────────────────────
  const current = await token.confiscationWallet();
  const pending = await token.pendingConfiscationWallet();

  if (current.toLowerCase() === destination.toLowerCase()) {
    console.log("\n[2/2] confiscationWallet already applied — nothing to do.");
  } else if (pending.toLowerCase() === destination.toLowerCase()) {
    const scheduledAt = await token.confiscationWalletScheduledAt();
    const delay = await token.UPGRADE_DELAY();
    console.log("\n[2/2] Already scheduled. Applicable after unix", (scheduledAt + delay).toString());
  } else {
    console.log("\n[2/2] Scheduling confiscationWallet (48h timelock)...");
    const tx = await token.connect(admin).scheduleConfiscationWallet(destination);
    await tx.wait();
    const scheduledAt = await token.confiscationWalletScheduledAt();
    const delay = await token.UPGRADE_DELAY();
    console.log("      scheduled:", tx.hash);
    console.log("      applicable after unix", (scheduledAt + delay).toString());
  }

  console.log(
    "\nNext: after the timelock, run scripts/apply-confiscation-wallet.ts on this network.",
  );
  console.log("Until confiscationWallet is APPLIED, confiscate() reverts ConfiscationWalletNotSet.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

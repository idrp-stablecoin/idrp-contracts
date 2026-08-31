import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import hre from "hardhat";

/**
 * Applies the scheduled confiscationWallet once its 48h timelock has expired.
 * Run after scripts/setup-confiscate.ts.
 *
 * Fails closed and explains why: too early, nothing pending, or the depository
 * moved onto the pending address during the window (the contract re-checks that
 * at apply time, which is the point of the re-check).
 *
 * Usage:
 *   npx hardhat run scripts/apply-confiscation-wallet.ts --network kairos
 *
 *   # mainnets additionally require ALLOW_MAINNET=1 (Rule 0: real on-chain
 *   # state — get explicit sign-off before running):
 *   ALLOW_MAINNET=1 npx hardhat run scripts/apply-confiscation-wallet.ts --network kaia
 *
 * Env:
 *   ALLOW_MAINNET=1  required ack to run against a mainnet chain id (1 / 56 / 137 / 8217).
 */

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

async function main() {
  const chainId = hre.network.config.chainId;
  if (chainId === undefined) throw new Error("network has no chainId configured");

  assertAllowedNetwork(chainId, hre.network.name);

  const deploymentPath = path.join(__dirname, `../deployment/chain-${chainId}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`no deployment record at ${deploymentPath}`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const signers = await ethers.getSigners();
  const token = await ethers.getContractAt("IDRP", deployment.IDRP);

  const current = await token.confiscationWallet();
  const pending = await token.pendingConfiscationWallet();
  const scheduledAt = await token.confiscationWalletScheduledAt();
  const delay = await token.UPGRADE_DELAY();

  // applyConfiscationWallet is admin-gated and the admin key differs per
  // network — resolve it from on-chain state, not a signer index.
  const onChainAdmin = await token.admin();
  const admin = signers.find(
    (s) => s.address.toLowerCase() === onChainAdmin.toLowerCase(),
  );
  if (!admin) {
    throw new Error(
      `None of the ${signers.length} configured signer(s) is token.admin() ` +
        `(${onChainAdmin}) on ${hre.network.name}. Available: ` +
        signers.map((s) => s.address).join(", "),
    );
  }

  console.log("network           ", hre.network.name, `(chainId ${chainId})`);
  console.log("token             ", deployment.IDRP);
  console.log("signer            ", admin.address);
  console.log("current wallet    ", current);
  console.log("pending wallet    ", pending);

  if (pending === ethers.ZeroAddress) {
    console.log("\nNothing pending. Either it was already applied, or run setup-confiscate.ts first.");
    return;
  }

  const applicableAt = scheduledAt + delay;
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  console.log("applicable after  ", applicableAt.toString(), `(now ${now})`);

  if (now < applicableAt) {
    const remaining = Number(applicableAt - now);
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    console.log(`\nToo early — ${h}h ${m}m remaining. The contract will revert "Timelock not expired".`);
    return;
  }

  console.log("\nApplying...");
  const tx = await token.connect(admin).applyConfiscationWallet();
  await tx.wait();
  console.log("applied:", tx.hash);
  console.log("confiscationWallet now", await token.confiscationWallet());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

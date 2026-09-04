import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Builds the admin-Safe transaction that seeds the Confiscate quorum rules
 * (OperationType 6) on IDRPController, and proves it will not revert.
 *
 * Seeding these rules is the single act that ARMS seizure on a chain — the
 * token-level path is already open once the implementation lands, because every
 * chain has a depositoryWallet. Treat this with that weight.
 *
 * WHY IT SIMULATES FIRST
 *
 * Safe swallows an inner revert and surfaces only `GS013`, which says nothing
 * about which call failed or why. So this eth_calls the inner
 * setQuorumRules FROM the Safe address before producing anything. If that
 * simulation fails, the Safe transaction would fail too — and you find out here
 * instead of after collecting three signatures.
 *
 * Outputs: the exact execTransaction parameters, the on-chain safeTxHash, this
 * signer's owner signature if we hold one, and a Safe Transaction Builder JSON.
 *
 * Usage:
 *   npx hardhat run scripts/safe-propose-confiscate-rules.ts --network baseSepolia
 *
 * Env:
 *   ALLOW_MAINNET=1  required ack for a mainnet chain id (Rule 0).
 */

const CONFISCATE_OP = 6;
const MAINNET_CHAIN_IDS = new Set([1, 56, 137, 8217]);

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
];

type RuleJson = { minAmount: string; maxAmount: string; requiredRoles: string[] };

async function main() {
  const chainId = hre.network.config.chainId;
  if (chainId === undefined) throw new Error("network has no chainId configured");
  if (MAINNET_CHAIN_IDS.has(chainId) && process.env.ALLOW_MAINNET !== "1") {
    throw new Error(
      `"${hre.network.name}" (chainId ${chainId}) is a MAINNET. Re-run with ALLOW_MAINNET=1 ` +
        `only after explicit sign-off (Rule 0).`
    );
  }

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployment/chain-${chainId}.json`), "utf8")
  );
  const controllerAddress: string = deployment.IDRPController;
  const tokenAddress: string = deployment.IDRP;

  const token = await hre.ethers.getContractAt("IDRP", tokenAddress);
  const controller = await hre.ethers.getContractAt("IDRPController", controllerAddress);
  const safeAddress: string = await token.admin();
  const safe = new hre.ethers.Contract(safeAddress, SAFE_ABI, hre.ethers.provider);

  console.log(`network        ${hre.network.name} (chainId ${chainId})`);
  console.log(`token          ${tokenAddress}`);
  console.log(`controller     ${controllerAddress}`);
  console.log(`admin Safe     ${safeAddress}`);
  console.log(`depository     ${await token.depositoryWallet()}   <- seizure destination`);

  // ── Refuse to arm a chain whose destination is unusable ────────────────────
  const depository = await token.depositoryWallet();
  if (depository === hre.ethers.ZeroAddress) throw new Error("depositoryWallet unset — do not arm");
  if (depository.toLowerCase() === tokenAddress.toLowerCase())
    throw new Error("depositoryWallet is the token — seized funds unrecoverable");
  if (depository.toLowerCase() === controllerAddress.toLowerCase())
    throw new Error("depositoryWallet is the controller — seized funds stranded");

  // ── Already armed? ─────────────────────────────────────────────────────────
  try {
    const live = await controller.getQuorumRule(CONFISCATE_OP, 0);
    console.log(`\nAlready armed: op ${CONFISCATE_OP} has a rule requiring ${live.requiredRoles.length} role(s). Nothing to propose.`);
    return;
  } catch {
    // "No matching quorum rule found" — expected while unseeded.
  }

  const rules: RuleJson[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../test/utils/rules.confiscate.json"), "utf8")
  );
  console.log(`\nrules.confiscate.json: ${rules.length} tier(s)`);
  rules.forEach((r, i) =>
    console.log(`  tier ${i}: [${r.minAmount}, ${r.maxAmount}) requires ${r.requiredRoles.length} role(s)`)
  );
  if (rules.length !== 1) {
    throw new Error("Confiscate must be single-tier — the Controller rejects anything else");
  }

  const data = controller.interface.encodeFunctionData("setQuorumRules", [
    CONFISCATE_OP,
    rules.map((r) => ({
      minAmount: BigInt(r.minAmount),
      maxAmount: BigInt(r.maxAmount),
      requiredRoles: r.requiredRoles,
    })),
  ]);

  // ── Simulate the INNER call from the Safe. This is the GS013 defence. ──────
  console.log("\nSimulating the inner call from the Safe...");
  try {
    await hre.ethers.provider.call({ from: safeAddress, to: controllerAddress, data });
    console.log("  OK — setQuorumRules succeeds when called by the Safe.");
  } catch (e: any) {
    throw new Error(
      `INNER CALL WOULD REVERT: ${e.shortMessage ?? e.message}\n` +
        `Do not collect signatures — the Safe execution would fail with GS013 and tell you nothing.`
    );
  }

  // ── Safe transaction parameters ────────────────────────────────────────────
  const nonce: bigint = await safe.nonce();
  const threshold: bigint = await safe.getThreshold();
  const owners: string[] = await safe.getOwners();
  const tx = {
    to: controllerAddress,
    value: 0n,
    data,
    operation: 0, // CALL. NEVER DelegateCall — that would run controller code in the Safe's context.
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: hre.ethers.ZeroAddress,
    refundReceiver: hre.ethers.ZeroAddress,
    nonce,
  };

  const safeTxHash: string = await safe.getTransactionHash(
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas,
    tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce
  );

  // Cross-check the contract's hash against locally computed EIP-712.
  const domain = { chainId, verifyingContract: safeAddress };
  const types = {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const localHash = hre.ethers.TypedDataEncoder.hash(domain, types, tx);
  if (localHash.toLowerCase() !== safeTxHash.toLowerCase()) {
    throw new Error(`safeTxHash mismatch: contract ${safeTxHash} vs local ${localHash}`);
  }

  console.log(`\nSafe v${await safe.VERSION()}   threshold ${threshold} of ${owners.length}   nonce ${nonce}`);
  console.log("\n--- execTransaction parameters ---");
  console.log(`  to             ${tx.to}`);
  console.log(`  value          0`);
  console.log(`  operation      0  (CALL - not DelegateCall)`);
  console.log(`  safeTxGas      0`);
  console.log(`  baseGas        0`);
  console.log(`  gasPrice       0`);
  console.log(`  gasToken       ${tx.gasToken}`);
  console.log(`  refundReceiver ${tx.refundReceiver}`);
  console.log(`  nonce          ${nonce}`);
  console.log(`  data           ${tx.data}`);
  console.log(`\n  safeTxHash     ${safeTxHash}   (verified against local EIP-712)`);

  // ── Sign with whichever owner keys we hold ────────────────────────────────
  const signers = await hre.ethers.getSigners();
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const mine = signers.filter((s) => ownerSet.has(s.address.toLowerCase()));
  console.log(`\nowners (${owners.length}):`);
  for (const o of owners) {
    const held = signers.some((s) => s.address.toLowerCase() === o.toLowerCase());
    console.log(`  ${o} ${held ? "<-- key available here" : ""}`);
  }

  if (mine.length) {
    console.log("\nsignatures from locally-held owner keys:");
    for (const s of mine) {
      const sig = await s.signTypedData(domain, types, tx);
      console.log(`  ${s.address}\n    ${sig}`);
    }
    console.log(
      `\n  ${mine.length} of ${threshold} collected. ${Number(threshold) - mine.length} more owner(s) must sign.`
    );
    console.log(
      "  To execute: concatenate signatures ordered by owner address ASCENDING,\n" +
      "  then call execTransaction with the parameters above."
    );
  } else {
    console.log("\nNo local owner keys — all signatures must come from elsewhere.");
  }

  // ── Safe Transaction Builder import file ──────────────────────────────────
  const builder = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name: `Arm Confiscate (op ${CONFISCATE_OP}) on ${hre.network.name}`,
      description:
        `setQuorumRules(${CONFISCATE_OP}, [1 tier, all 4 roles]) on IDRPController ${controllerAddress}. ` +
        `Arms seizure. Seized funds go to depositoryWallet ${depository}. ` +
        `Send as a SINGLE transaction — a MultiSend batch turns an inner revert into a bare GS013.`,
      txBuilderVersion: "1.16.5",
    },
    transactions: [{ to: tx.to, value: "0", data: tx.data }],
  };
  const outPath = path.join(__dirname, `../deployment/safe-arm-confiscate-${chainId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(builder, null, 2));
  console.log(`\nSafe Transaction Builder file: ${path.relative(process.cwd(), outPath)}`);
  console.log("Import it in the Safe UI (Transaction Builder), or enter the parameters by hand.");
}

main().catch((e) => {
  console.error("\n" + (e.message ?? e));
  process.exitCode = 1;
});

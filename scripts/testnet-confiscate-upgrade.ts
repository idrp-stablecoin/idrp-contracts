import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Two-step token upgrade for the confiscate→depository change, TESTNET ONLY.
 *
 *   STEP=schedule  deploy the implementation and start the timelock
 *   STEP=execute   run upgradeToAndCall once the timelock has expired
 *   STEP=verify    verify the deployed implementation on the block explorer
 *
 * Only the TOKEN changes. The Controller never referenced the confiscation
 * destination, so its deployed implementation stays as-is.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN scripts/schedule-upgrade.ts
 *
 * The implementations live on Kairos and Base Sepolia were built with a
 * 5-minute UPGRADE_DELAY override, not the canonical 48h. UPGRADE_DELAY is a
 * `constant`, so it lives in bytecode: rebuilding from canonical source would
 * silently take those chains to 48h and make every later test upgrade cost two
 * days. Last time that override was an uncommitted worktree edit, which then
 * broke explorer verification because nobody recorded what was actually built.
 *
 * So this script applies the override deterministically, restores the source in
 * a `finally`, asserts the file came back byte-identical, asserts the DEPLOYED
 * bytecode reports the delay we intended, and records that delay in the
 * deployment JSON as `IDRPImplUpgradeDelay` so verification can reproduce it.
 *
 * Usage:
 *   STEP=schedule npx hardhat run scripts/testnet-confiscate-upgrade.ts --network kairos
 *   # wait out the delay, then:
 *   STEP=execute  npx hardhat run scripts/testnet-confiscate-upgrade.ts --network kairos
 *
 * Env:
 *   STEP                 schedule | execute (required)
 *   IMPL_UPGRADE_DELAY   seconds to bake into the new implementation.
 *                        Defaults to whatever the CURRENTLY deployed
 *                        implementation reports, so a chain keeps its existing
 *                        convention unless you deliberately change it.
 */

const CANONICAL_DELAY_LINE = "    uint256 public constant UPGRADE_DELAY = 48 hours;";
const IDRP_SOURCE = path.join(__dirname, "../contracts/IDRP.sol");

/** Chain ids that hold real value. This script refuses them outright. */
const MAINNET_CHAIN_IDS = new Set([1, 56, 137, 8217]);
/** The only chains this script will touch. */
const ALLOWED_TESTNETS = new Set([1001, 84532, 17000, 11155111]);

function deploymentPath(chainId: number) {
  return path.join(__dirname, `../deployment/chain-${chainId}.json`);
}

async function resolveUpgrader(token: any) {
  const upgrader: string = await token.upgrader();
  const signers = await hre.ethers.getSigners();
  const match = signers.find(
    (s) => s.address.toLowerCase() === upgrader.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `None of the ${signers.length} configured signer(s) is token.upgrader() ` +
        `(${upgrader}). Available: ${signers.map((s) => s.address).join(", ")}`
    );
  }
  return match;
}

/**
 * Compiles and deploys an IDRP implementation with `delaySeconds` baked in.
 * Restores contracts/IDRP.sol unconditionally and verifies the restoration.
 */
async function deployImplWithDelay(deployer: any, delaySeconds: number) {
  const original = fs.readFileSync(IDRP_SOURCE, "utf8");
  if (!original.includes(CANONICAL_DELAY_LINE)) {
    throw new Error(
      `contracts/IDRP.sol does not contain the canonical line:\n  ${CANONICAL_DELAY_LINE}\n` +
        `Refusing to patch a file I do not recognise — is the tree already dirty?`
    );
  }

  try {
    if (delaySeconds !== 48 * 3600) {
      const patched = original.replace(
        CANONICAL_DELAY_LINE,
        `    uint256 public constant UPGRADE_DELAY = ${delaySeconds} seconds;`
      );
      fs.writeFileSync(IDRP_SOURCE, patched);
      console.log(`  patched UPGRADE_DELAY -> ${delaySeconds}s for this build`);
    }
    await hre.run("compile", { force: true, quiet: true });

    const Factory = await hre.ethers.getContractFactory("IDRP", deployer);
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    const address = await impl.getAddress();

    // The check that actually matters: what did we DEPLOY, not what did we mean.
    const onChainDelay = await (impl as any).UPGRADE_DELAY();
    if (Number(onChainDelay) !== delaySeconds) {
      throw new Error(
        `deployed implementation reports UPGRADE_DELAY=${onChainDelay}, expected ${delaySeconds}`
      );
    }
    console.log(`  implementation ${address} (UPGRADE_DELAY ${onChainDelay}s)`);
    return address;
  } finally {
    fs.writeFileSync(IDRP_SOURCE, original);
    if (fs.readFileSync(IDRP_SOURCE, "utf8") !== original) {
      throw new Error("FAILED TO RESTORE contracts/IDRP.sol — fix by hand before committing");
    }
    console.log("  contracts/IDRP.sol restored to canonical 48h");
  }
}

async function main() {
  const step = process.env.STEP;
  if (step !== "schedule" && step !== "execute" && step !== "verify") {
    throw new Error("set STEP=schedule, STEP=execute or STEP=verify");
  }

  const chainId = hre.network.config.chainId;
  if (chainId === undefined) throw new Error("network has no chainId configured");
  if (MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(`REFUSING: ${hre.network.name} (chainId ${chainId}) is a MAINNET.`);
  }
  if (!ALLOWED_TESTNETS.has(chainId)) {
    throw new Error(
      `REFUSING: chainId ${chainId} is not in this script's testnet allow-list.`
    );
  }

  const file = deploymentPath(chainId);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxy: string = deployment.IDRP;

  const token = await hre.ethers.getContractAt("IDRP", proxy);
  const upgrader = await resolveUpgrader(token);
  const tokenAsUpgrader = token.connect(upgrader) as any;

  const liveDelay = await token.UPGRADE_DELAY();
  const currentImpl = await hre.upgrades.erc1967.getImplementationAddress(proxy);

  console.log(`network        ${hre.network.name} (chainId ${chainId}) TESTNET`);
  console.log(`token proxy    ${proxy}`);
  console.log(`current impl   ${currentImpl}`);
  console.log(`upgrader       ${upgrader.address}`);
  console.log(`live delay     ${liveDelay}s`);
  console.log(`depository     ${await token.depositoryWallet()}   <- new seizure destination`);
  console.log(`slot 9         ${await hre.ethers.provider.getStorage(proxy, 9)}`);

  if (step === "verify") {
    // Explorer verification matches SOURCE against DEPLOYED bytecode, so the
    // 5-minute override has to be re-applied or the verify fails on a bytecode
    // mismatch — which looks like a tooling problem, not a source problem, and
    // is exactly what cost an afternoon last time. The delay is read from the
    // deployment JSON rather than guessed.
    const recorded = deployment.IDRPImplUpgradeDelay;
    const target = deployment.IDRPImpl ?? currentImpl;
    if (!recorded) {
      throw new Error(
        `chain-${chainId}.json has no IDRPImplUpgradeDelay — cannot know what source ` +
          `the deployed implementation was built from. Do not guess.`
      );
    }
    const delaySeconds = Number(recorded);
    console.log(`\nVerifying ${target} with UPGRADE_DELAY=${delaySeconds}s...`);

    const original = fs.readFileSync(IDRP_SOURCE, "utf8");
    if (!original.includes(CANONICAL_DELAY_LINE)) {
      throw new Error("contracts/IDRP.sol is not canonical — refusing to patch");
    }
    try {
      if (delaySeconds !== 48 * 3600) {
        fs.writeFileSync(
          IDRP_SOURCE,
          original.replace(
            CANONICAL_DELAY_LINE,
            `    uint256 public constant UPGRADE_DELAY = ${delaySeconds} seconds;`
          )
        );
      }
      await hre.run("compile", { force: true, quiet: true });
      await hre.run("verify:verify", { address: target, constructorArguments: [] });
      console.log("\nVerified.");
    } finally {
      fs.writeFileSync(IDRP_SOURCE, original);
      if (fs.readFileSync(IDRP_SOURCE, "utf8") !== original) {
        throw new Error("FAILED TO RESTORE contracts/IDRP.sol — fix by hand before committing");
      }
      console.log("contracts/IDRP.sol restored to canonical 48h");
    }
    return;
  }

  if (step === "schedule") {
    const pending = await token.scheduledImplementation();
    if (pending !== hre.ethers.ZeroAddress) {
      console.log(`\nAlready scheduled: ${pending}. Run STEP=execute, or cancel first.`);
      return;
    }

    const delaySeconds = Number(process.env.IMPL_UPGRADE_DELAY ?? liveDelay);
    console.log(`\nBuilding implementation with UPGRADE_DELAY=${delaySeconds}s...`);
    const implAddress = await deployImplWithDelay(upgrader, delaySeconds);

    console.log("\nScheduling...");
    const tx = await tokenAsUpgrader.scheduleUpgrade(implAddress);
    await tx.wait();

    const scheduledAt = await token.upgradeScheduledAt();
    const executableAfter = scheduledAt + liveDelay;
    console.log(`  scheduleUpgrade tx  ${tx.hash}`);
    console.log(`  executable after    ${executableAfter} (${new Date(Number(executableAfter) * 1000).toISOString()})`);
    console.log(`  wait                ${liveDelay}s — gated by the CURRENT impl, not the new one`);

    deployment.IDRPScheduledImpl = implAddress;
    deployment.IDRPScheduledAt = scheduledAt.toString();
    deployment.IDRPExecutableAfter = executableAfter.toString();
    // So explorer verification knows what source to reproduce.
    deployment.IDRPImplUpgradeDelay = String(delaySeconds);
    fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
    console.log(`  recorded in ${path.basename(file)} (IDRPImplUpgradeDelay=${delaySeconds})`);
    return;
  }

  // ── execute ────────────────────────────────────────────────────────────────
  const scheduled: string = await token.scheduledImplementation();
  if (scheduled === hre.ethers.ZeroAddress) {
    console.log("\nNothing scheduled. Run STEP=schedule first.");
    return;
  }
  const scheduledAt = await token.upgradeScheduledAt();
  const executableAfter = scheduledAt + liveDelay;
  const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
  if (now < executableAfter) {
    const remaining = Number(executableAfter - now);
    console.log(`\nToo early — ${Math.floor(remaining / 60)}m ${remaining % 60}s remaining.`);
    return;
  }

  // Capture what must survive the upgrade.
  const pre = {
    admin: await token.admin(),
    upgrader: await token.upgrader(),
    controller: await token.controller(),
    depository: await token.depositoryWallet(),
    totalSupply: await token.totalSupply(),
    slot9: await hre.ethers.provider.getStorage(proxy, 9),
    slot10: await hre.ethers.provider.getStorage(proxy, 10),
    slot11: await hre.ethers.provider.getStorage(proxy, 11),
  };

  console.log(`\nExecuting upgrade to ${scheduled}...`);
  const tx = await tokenAsUpgrader.upgradeToAndCall(scheduled, "0x");
  await tx.wait();
  console.log(`  upgradeToAndCall tx ${tx.hash}`);

  const newImpl = await hre.upgrades.erc1967.getImplementationAddress(proxy);
  const checks: [string, boolean, string][] = [
    ["implementation swapped", newImpl.toLowerCase() === scheduled.toLowerCase(), newImpl],
    ["schedule cleared", (await token.scheduledImplementation()) === hre.ethers.ZeroAddress, ""],
    ["admin preserved", (await token.admin()) === pre.admin, pre.admin],
    ["upgrader preserved", (await token.upgrader()) === pre.upgrader, pre.upgrader],
    ["controller preserved", (await token.controller()) === pre.controller, pre.controller],
    ["depository preserved", (await token.depositoryWallet()) === pre.depository, pre.depository],
    ["totalSupply preserved", (await token.totalSupply()) === pre.totalSupply, pre.totalSupply.toString()],
    ["slot 9 reserved", (await hre.ethers.provider.getStorage(proxy, 9)) === pre.slot9, pre.slot9],
    ["slot 10 reserved", (await hre.ethers.provider.getStorage(proxy, 10)) === pre.slot10, ""],
    ["slot 11 reserved", (await hre.ethers.provider.getStorage(proxy, 11)) === pre.slot11, ""],
  ];

  console.log("\nPost-upgrade checks:");
  let allOk = true;
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${label.padEnd(24)} ${detail}`);
    if (!ok) allOk = false;
  }

  // The retired selectors must not dispatch into live code.
  for (const sig of [
    "confiscationWallet()",
    "pendingConfiscationWallet()",
    "confiscationWalletScheduledAt()",
    "scheduleConfiscationWallet(address)",
    "applyConfiscationWallet()",
    "cancelConfiscationWallet()",
  ]) {
    const data = hre.ethers.id(sig).slice(0, 10) + "0".repeat(64);
    let reverted = false;
    try {
      await hre.ethers.provider.call({ to: proxy, data });
    } catch {
      reverted = true;
    }
    console.log(`  ${reverted ? "OK  " : "FAIL"}  retired selector reverts  ${sig}`);
    if (!reverted) allOk = false;
  }

  console.log(`\nnew UPGRADE_DELAY  ${await token.UPGRADE_DELAY()}s`);

  delete deployment.IDRPScheduledImpl;
  delete deployment.IDRPScheduledAt;
  delete deployment.IDRPExecutableAfter;
  deployment.IDRPImpl = newImpl;
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));

  if (!allOk) throw new Error("POST-UPGRADE CHECKS FAILED — investigate before touching another chain");
  console.log("\nAll post-upgrade checks passed.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});

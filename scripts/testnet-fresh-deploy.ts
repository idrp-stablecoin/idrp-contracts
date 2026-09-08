import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Fresh IDRP + IDRPController proxies on a TESTNET, on the placeholder-free
 * storage layout.
 *
 * WHY A FRESH PROXY AND NOT AN UPGRADE
 *
 * Kairos and Base Sepolia are the only two chains that ever deployed the variant
 * which RESERVED the retired confiscation slots with `__deprecated_*`
 * placeholders. Upgrading those proxies onto the placeholder-free layout is a
 * storage DELETION, which OpenZeppelin's validator rejects and has no annotation
 * to express. Every other chain reaches the clean layout by ordinary upgrade —
 * see test/confiscate/UpgradePaths.ts, which asserts all four paths.
 *
 * So the clean layout costs two testnet redeploys instead of three dead slots on
 * production or a blanket `unsafeSkipStorageCheck`.
 *
 * The Controller is redeployed too because `idrpToken` is set in its initializer
 * and has no setter — a new token proxy cannot be adopted by the old controller.
 *
 * WHAT THIS CHANGES, deliberately, and you should know before running it:
 *   - New addresses. The dashboard's AppSettings must be repointed.
 *   - Balances start empty; a test supply is minted at the end.
 *   - `admin` becomes the DEPLOYER, not the Safe that admins the old proxies.
 *     Granting roles and seeding rules are DEFAULT_ADMIN-gated, so the deployer
 *     has to hold it during setup. Hand it to a Safe afterwards if you want the
 *     old posture back (token: setAdmin, instant; controller: the
 *     AccessControlDefaultAdminRules two-step, which the Safe must accept).
 *
 * Usage:
 *   npx hardhat run scripts/testnet-fresh-deploy.ts --network baseSepolia
 *
 * Env:
 *   IMPL_UPGRADE_DELAY   seconds to bake into UPGRADE_DELAY. Defaults to 300 to
 *                        match the existing testnet convention; the canonical
 *                        source is 48h and that constant lives in bytecode.
 *   MINT_IDRP            whole IDRP to mint as test supply (default 1000000).
 */

const IDRP_SOURCE = path.join(__dirname, "../contracts/IDRP.sol");
const CONTROLLER_SOURCE = path.join(__dirname, "../contracts/IDRPController.sol");

/**
 * Every 48h constant that has to move together.
 *
 * The Controller has TWO, and missing them is not cosmetic: a controller cannot
 * shorten its own UPGRADE_DELAY without first waiting out the delay it already
 * has, so shipping a 48h controller to a testnet locks that chain into two-day
 * iteration until someone redeploys it.
 */
const DELAY_LINES: Array<[string, string]> = [
  [IDRP_SOURCE, "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  [CONTROLLER_SOURCE, "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  [CONTROLLER_SOURCE, "    uint48 public constant DEFAULT_ADMIN_DELAY = 48 hours;"],
];

const MAINNET_CHAIN_IDS = new Set([1, 56, 137, 8217]);
const ALLOWED_TESTNETS = new Set([1001, 84532]);

/** The quorum signers, mirrored from what is live on the existing controllers. */
const QUORUM_SIGNERS: Record<string, string> = {
  OFFICER_ROLE: "0x99A0AD5DF1651D8812B0b4Ca5102ad060C4DC2d3",
  MANAGER_ROLE: "0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761",
  DIRECTOR_ROLE: "0x5B2A48685a89458ECbaB3AEC56923e128f441995",
  COMMISSIONER_ROLE: "0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed",
};

/** operationType -> fixture file. Every op the controller knows. */
const RULE_FILES: Array<[number, string, string]> = [
  [0, "Mint", "rules.mint.burn.json"],
  [1, "Burn", "rules.mint.burn.json"],
  [2, "Freeze", "rules.freeze.unfreeze.json"],
  [3, "Unfreeze", "rules.freeze.unfreeze.json"],
  [4, "Pause", "rules.pause.json"],
  [5, "Unpause", "rules.unpause.json"],
  [6, "Confiscate", "rules.confiscate.json"],
];

type RuleJson = { minAmount: string; maxAmount: string; requiredRoles: string[] };

function loadRules(file: string): RuleJson[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "../test/utils", file), "utf8"));
}

/**
 * Compiles with `delaySeconds` baked into UPGRADE_DELAY, restores the source
 * unconditionally, and verifies the restoration.
 */
async function withDelayOverride<T>(delaySeconds: number, fn: () => Promise<T>): Promise<T> {
  const originals = new Map<string, string>();
  for (const [file] of DELAY_LINES) {
    if (!originals.has(file)) originals.set(file, fs.readFileSync(file, "utf8"));
  }
  for (const [file, line] of DELAY_LINES) {
    if (!originals.get(file)!.includes(line)) {
      throw new Error(`${path.basename(file)} does not contain "${line.trim()}" — refusing to patch a tree I don't recognise`);
    }
  }

  try {
    if (delaySeconds !== 48 * 3600) {
      for (const [file, line] of DELAY_LINES) {
        const current = fs.readFileSync(file, "utf8");
        const type = line.includes("uint48") ? "uint48" : "uint256";
        const name = line.includes("DEFAULT_ADMIN_DELAY") ? "DEFAULT_ADMIN_DELAY" : "UPGRADE_DELAY";
        fs.writeFileSync(
          file,
          current.replace(line, `    ${type} public constant ${name} = ${delaySeconds} seconds;`),
        );
      }
      console.log(`  patched ${DELAY_LINES.length} delay constants -> ${delaySeconds}s for this build`);
    }
    await hre.run("compile", { force: true, quiet: true });
    return await fn();
  } finally {
    for (const [file, content] of originals) {
      fs.writeFileSync(file, content);
      if (fs.readFileSync(file, "utf8") !== content) {
        throw new Error(`FAILED TO RESTORE ${path.basename(file)} — fix by hand before committing`);
      }
    }
    console.log("  sources restored to canonical 48h");
  }
}

async function main() {
  const chainId = hre.network.config.chainId;
  if (chainId === undefined) throw new Error("network has no chainId configured");
  if (MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(`REFUSING: ${hre.network.name} (chainId ${chainId}) is a MAINNET.`);
  }
  if (!ALLOWED_TESTNETS.has(chainId)) {
    throw new Error(`REFUSING: chainId ${chainId} is not in this script's allow-list.`);
  }

  const file = path.join(__dirname, `../deployment/chain-${chainId}.json`);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await hre.ethers.getSigners();

  // Carry forward the things the old deployment defines rather than re-deciding
  // them here: whatever the old token used as depository stays the depository.
  const oldToken = await hre.ethers.getContractAt("IDRP", deployment.IDRP);
  const depository: string = await oldToken.depositoryWallet();

  console.log(`network         ${hre.network.name} (chainId ${chainId}) TESTNET`);
  console.log(`deployer        ${deployer.address}`);
  console.log(`balance         ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))}`);
  console.log(`OLD token       ${deployment.IDRP}`);
  console.log(`OLD controller  ${deployment.IDRPController}`);
  console.log(`depository      ${depository}   (carried forward)`);
  if (depository === hre.ethers.ZeroAddress) throw new Error("old depository is unset — refusing to guess");

  const delaySeconds = Number(process.env.IMPL_UPGRADE_DELAY ?? 300);
  const mintWhole = process.env.MINT_IDRP ?? "1000000";

  const { token, controller, tokenImpl, controllerImpl } = await withDelayOverride(
    delaySeconds,
    async () => {
      console.log("\n[1/6] Deploying IDRP proxy...");
      const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
      const token = await hre.upgrades.deployProxy(IDRPFactory, [deployer.address], {
        kind: "uups",
      });
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();
      const tokenImpl = await hre.upgrades.erc1967.getImplementationAddress(tokenAddr);
      console.log(`      proxy ${tokenAddr}  impl ${tokenImpl}`);
      const onChainDelay = await (token as any).UPGRADE_DELAY();
      if (Number(onChainDelay) !== delaySeconds) {
        throw new Error(`deployed UPGRADE_DELAY=${onChainDelay}, expected ${delaySeconds}`);
      }

      console.log("\n[2/6] Deploying IDRPController proxy...");
      const CtrlFactory = await hre.ethers.getContractFactory("IDRPController");
      const controller = await hre.upgrades.deployProxy(
        CtrlFactory,
        [tokenAddr, deployer.address],
        { kind: "uups" },
      );
      await controller.waitForDeployment();
      const ctrlAddr = await controller.getAddress();
      const controllerImpl = await hre.upgrades.erc1967.getImplementationAddress(ctrlAddr);
      console.log(`      proxy ${ctrlAddr}  impl ${controllerImpl}`);
      const ctrlDelay = await (controller as any).UPGRADE_DELAY();
      if (Number(ctrlDelay) !== delaySeconds) {
        throw new Error(
          `controller UPGRADE_DELAY=${ctrlDelay}, expected ${delaySeconds}. A controller ` +
            `cannot shorten its own delay without first waiting it out — do not ship this.`,
        );
      }
      return { token, controller, tokenImpl, controllerImpl };
    },
  );

  const tokenAddr = await token.getAddress();
  const ctrlAddr = await controller.getAddress();

  console.log("\n[3/6] Wiring the token...");
  await (await (token as any).setDepositoryWallet(depository)).wait();
  await (await (token as any).setController(ctrlAddr)).wait();
  console.log(`      depositoryWallet=${await (token as any).depositoryWallet()}`);
  console.log(`      controller=${await (token as any).controller()}`);

  console.log("\n[4/6] Granting quorum roles...");
  for (const [role, addr] of Object.entries(QUORUM_SIGNERS)) {
    const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(role));
    await (await (controller as any).grantRole(hash, addr)).wait();
    console.log(`      ${role.replace("_ROLE", "").padEnd(13)} ${addr}`);
  }

  console.log("\n[5/6] Seeding quorum rules...");
  for (const [op, name, fileName] of RULE_FILES) {
    const rules = loadRules(fileName).map((r) => ({
      minAmount: BigInt(r.minAmount),
      maxAmount: BigInt(r.maxAmount),
      requiredRoles: r.requiredRoles,
    }));
    await (await (controller as any).setQuorumRules(op, rules)).wait();
    const live = await (controller as any).getQuorumRule(op, 0);
    console.log(`      op ${op} ${name.padEnd(11)} ${rules.length} tier(s), tier0 needs ${live.requiredRoles.length} role(s)`);
  }

  console.log("\n[6/6] Minting test supply...");
  // mint() is onlyController, so flip the wiring briefly — the same convention
  // the test suite uses. Put it back immediately.
  await (await (token as any).setController(deployer.address)).wait();
  await (await (token as any).mint(hre.ethers.parseUnits(mintWhole, 6))).wait();
  await (await (token as any).setController(ctrlAddr)).wait();
  console.log(`      totalSupply=${await (token as any).totalSupply()} (${mintWhole} IDRP to the depository)`);
  if ((await (token as any).controller()) !== ctrlAddr) {
    throw new Error("controller was not restored after minting");
  }

  // ── Record, keeping the superseded addresses rather than overwriting them ──
  deployment.IDRPPrevious = deployment.IDRP;
  deployment.IDRPControllerPrevious = deployment.IDRPController;
  deployment.IDRP = tokenAddr;
  deployment.IDRPController = ctrlAddr;
  deployment.IDRPImpl = tokenImpl;
  deployment.IDRPControllerImpl = controllerImpl;
  deployment.IDRPImplUpgradeDelay = String(delaySeconds);
  delete deployment.IDRPScheduledImpl;
  delete deployment.IDRPScheduledAt;
  delete deployment.IDRPExecutableAfter;
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));

  console.log("\n─────────────────────────────────────────────────────");
  console.log(`NEW token       ${tokenAddr}`);
  console.log(`NEW controller  ${ctrlAddr}`);
  console.log(`token impl      ${tokenImpl}`);
  console.log(`controller impl ${controllerImpl}`);
  console.log(`admin           ${await (token as any).admin()}  (deployer — NOT the old Safe)`);
  console.log(`UPGRADE_DELAY   ${await (token as any).UPGRADE_DELAY()}s`);
  console.log("\nDashboard AppSettings to repoint:");
  console.log(`  idrpAddress${chainId}        = ${tokenAddr}`);
  console.log(`  controllerAddress${chainId}  = ${ctrlAddr}`);
}

main().catch((e) => {
  console.error("\n" + (e.message ?? e));
  process.exitCode = 1;
});

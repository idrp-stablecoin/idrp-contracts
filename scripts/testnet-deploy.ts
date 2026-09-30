import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import hre from "hardhat";

/**
 * Deploys the `testnet` environment: fresh IDRP + IDRPController proxies on a
 * testnet, built from this tree with every timelock cut to 5 minutes.
 *
 * `testnet` runs the mainnet source: same features, same logic. The only
 * difference is the build. The constants in DELAY_LINES are edited to
 * `5 minutes` for the compile and restored straight after; nothing is
 * committed. Mainnet chain ids are refused.
 *
 * It wires what the mainnets have: depository, controller, sanctions list, the
 * four quorum roles and the quorum rules in test/utils/rules.*.json (the tiers
 * the mainnets run). The wallets are the ones today's testnets use.
 *
 * Records:
 *   deployment/testnet/chain-<chainId>.json             addresses, wiring, source commit
 *   deployment/builds/<chainId>/<implementation>.json   exact compiler input of each
 *                                                       implementation, for reproduction
 *                                                       and explorer verification
 *
 * Usage:
 *   npx hardhat run scripts/testnet-deploy.ts --network baseSepolia
 *   npx hardhat run scripts/testnet-deploy.ts --network kairos
 *   npx hardhat run scripts/testnet-deploy.ts              (local rehearsal, records to a temp dir)
 *
 * Env:
 *   MINT_IDRP        whole IDRP minted to the depository as test supply (default 1000000, 0 skips)
 *   SANCTIONS_LIST   sanctions list to wire. Otherwise the chain's known testnet list, or a fresh
 *                    SanctionsList owned by the deployer.
 */

const ENV = "testnet";
const DELAY_TEXT = "5 minutes";
const DELAY_SECONDS = 300;

/** Every timelock constant; each one is edited for the testnet build. */
const DELAY_LINES: Array<[string, string]> = [
  ["contracts/IDRP.sol", "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  ["contracts/IDRPController.sol", "    uint256 public constant UPGRADE_DELAY = 48 hours;"],
  ["contracts/IDRPController.sol", "    uint48 public constant DEFAULT_ADMIN_DELAY = 48 hours;"],
];

const MAINNET_CHAIN_IDS = new Set([1, 56, 137, 8217, 728126428]);
const LOCAL_CHAIN_ID = 31337;
const ALLOWED_CHAIN_IDS = new Set([84532, 1001, LOCAL_CHAIN_ID]);

/** Quorum signers and depository: the wallets today's testnets use. */
const QUORUM_SIGNERS: Record<string, string> = {
  OFFICER_ROLE: "0x99A0AD5DF1651D8812B0b4Ca5102ad060C4DC2d3",
  MANAGER_ROLE: "0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761",
  DIRECTOR_ROLE: "0x5B2A48685a89458ECbaB3AEC56923e128f441995",
  COMMISSIONER_ROLE: "0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed",
};
const DEPOSITORY = "0x0FC4CBd7f60E0BE5FeaCFAB6B8818F88763f9640";

/** Testnet sanctions lists that already exist (our SanctionsList clone). */
const KNOWN_SANCTIONS_LISTS: Record<number, string> = {
  84532: "0x4DC902bb835f9A9f93ADd277E31B98Fc06790023",
};

/** operationType -> rule file. The same tiers Ethereum, BSC and Kaia run. */
const RULE_FILES: Array<[number, string, string]> = [
  [0, "Mint", "rules.mint.burn.json"],
  [1, "Burn", "rules.mint.burn.json"],
  [2, "Freeze", "rules.freeze.unfreeze.json"],
  [3, "Unfreeze", "rules.freeze.unfreeze.json"],
  [4, "Pause", "rules.pause.json"],
  [5, "Unpause", "rules.unpause.json"],
];

type Rule = { minAmount: bigint; maxAmount: bigint; requiredRoles: string[] };
type BuildRecord = { contract: string; compiler: string; input: unknown };

const root = hre.config.paths.root;
const sh = (cmd: string) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();

/**
 * Role order where the mainnets differ from the fixture. The controller checks
 * required roles in array order, so this keeps the rule byte-identical to
 * Ethereum, BSC and Kaia (the fixture lists the same two roles reversed).
 */
const MAINNET_ROLE_ORDER: Record<number, string[]> = {
  4: ["DIRECTOR_ROLE", "MANAGER_ROLE"],
};

function loadRules(op: number, file: string): Rule[] {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "test/utils", file), "utf8"));
  const rules: Rule[] = raw.map((r: any) => ({
    minAmount: BigInt(r.minAmount),
    maxAmount: BigInt(r.maxAmount),
    requiredRoles: r.requiredRoles,
  }));
  const order = MAINNET_ROLE_ORDER[op];
  if (order) {
    const wanted = order.map((role) => hre.ethers.id(role));
    for (const r of rules) {
      if ([...r.requiredRoles].sort().join() !== [...wanted].sort().join()) {
        throw new Error(`op ${op}: fixture roles changed — re-check MAINNET_ROLE_ORDER`);
      }
      r.requiredRoles = wanted;
    }
  }
  return rules;
}

/** The exact compiler input for one contract, trimmed to the files it was built from. */
async function buildRecord(fqn: string): Promise<BuildRecord> {
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`no build info for ${fqn}`);
  const [source, name] = fqn.split(":");
  const metadata = JSON.parse((buildInfo.output.contracts[source][name] as any).metadata);
  const sources: Record<string, unknown> = {};
  for (const file of Object.keys(metadata.sources)) sources[file] = buildInfo.input.sources[file];
  return { contract: fqn, compiler: `v${buildInfo.solcLongVersion}`, input: { ...buildInfo.input, sources } };
}

/** Proves the runtime code at `impl` is the artifact just built, immutables aside. */
async function assertDeployedIsBuilt(fqn: string, impl: string) {
  const [source, name] = fqn.split(":");
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  const artifact = await hre.artifacts.readArtifact(fqn);
  const immutables = Object.values(
    ((buildInfo!.output.contracts[source][name] as any).evm.deployedBytecode.immutableReferences ?? {}) as Record<
      string,
      { start: number; length: number }[]
    >
  ).flat();
  const deployed = Buffer.from((await hre.ethers.provider.getCode(impl)).slice(2), "hex");
  const built = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
  const self = Buffer.from(impl.slice(2).toLowerCase(), "hex");
  if (deployed.length !== built.length) throw new Error(`${name}: deployed ${deployed.length}B != built ${built.length}B`);
  for (const { start, length } of immutables) {
    if (!deployed.subarray(start + length - 20, start + length).equals(self)) {
      throw new Error(`${name}: immutable at ${start} is not the implementation's own address`);
    }
    deployed.fill(0, start, start + length);
    built.fill(0, start, start + length);
  }
  if (!deployed.equals(built)) throw new Error(`${name}: deployed code is not the build`);
}

/** Compiles with every delay at 5 minutes, runs `fn`, then restores the sources and rebuilds. */
async function withTestnetDelays<T>(fn: () => Promise<T>): Promise<T> {
  const files = [...new Set(DELAY_LINES.map(([f]) => f))];
  const originals = new Map(files.map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]));
  const patched = new Map(originals);
  for (const [file, line] of DELAY_LINES) {
    const src = patched.get(file)!;
    if (src.split(line).length !== 2) {
      throw new Error(`${file}: expected exactly one "${line.trim()}" — refusing to patch a tree I don't recognise`);
    }
    patched.set(file, src.replace(line, line.replace("48 hours", DELAY_TEXT)));
  }
  try {
    for (const [file, src] of patched) fs.writeFileSync(path.join(root, file), src);
    console.log(`  build: ${DELAY_LINES.length} delay constants -> ${DELAY_TEXT}`);
    await hre.run("compile", { quiet: true });
    return await fn();
  } finally {
    for (const [file, src] of originals) {
      fs.writeFileSync(path.join(root, file), src);
      if (fs.readFileSync(path.join(root, file), "utf8") !== src) {
        throw new Error(`FAILED TO RESTORE ${file} — fix by hand before committing`);
      }
    }
    await hre.run("compile", { quiet: true });
    console.log("  sources restored to 48 hours, artifacts rebuilt");
  }
}

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (MAINNET_CHAIN_IDS.has(chainId)) throw new Error(`REFUSING: chainId ${chainId} is a MAINNET.`);
  if (!ALLOWED_CHAIN_IDS.has(chainId)) throw new Error(`REFUSING: chainId ${chainId} is not an allowed testnet.`);
  const local = chainId === LOCAL_CHAIN_ID;

  const recordDir = local ? fs.mkdtempSync(path.join(os.tmpdir(), "idrp-testnet-")) : path.join(root, "deployment");
  const recordFile = path.join(recordDir, ENV, `chain-${chainId}.json`);
  if (fs.existsSync(recordFile)) {
    throw new Error(`${path.relative(root, recordFile)} exists — ${ENV} is already deployed here. Refusing to deploy twice.`);
  }
  const commit = sh("git rev-parse HEAD");
  // Only the build inputs have to match the recorded commit; deployment records
  // and the upgrades plugin's manifests change as a side effect of deploying.
  if (!local && sh("git status --porcelain --untracked-files=no -- contracts hardhat.config.ts package.json package-lock.json") !== "") {
    throw new Error("contracts/, hardhat.config.ts or the lockfile have uncommitted changes — commit first, so the recorded commit is the real source");
  }

  const [deployer] = await hre.ethers.getSigners();
  const mintWhole = process.env.MINT_IDRP ?? "1000000";
  console.log(`network         ${hre.network.name} (chainId ${chainId})${local ? " LOCAL REHEARSAL" : ""}`);
  console.log(`env             ${ENV}   source ${commit.slice(0, 7)}`);
  console.log(`deployer        ${deployer.address}`);
  console.log(`balance         ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))}`);

  // The upgrades plugin reuses any implementation in .openzeppelin/ whose code
  // matches ignoring metadata. That hands back an older build (other comments,
  // other delay text) whose source this run did not record, so always deploy.
  const proxyOpts = { kind: "uups" as const, redeployImplementation: "always" as const };

  const built = await withTestnetDelays(async () => {
    console.log("\n[1/7] IDRP proxy");
    const token = await hre.upgrades.deployProxy(await hre.ethers.getContractFactory("IDRP"), [deployer.address], proxyOpts);
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
    const tokenImpl = await hre.upgrades.erc1967.getImplementationAddress(tokenAddr);
    console.log(`      proxy ${tokenAddr}  impl ${tokenImpl}`);

    console.log("\n[2/7] IDRPController proxy");
    const controller = await hre.upgrades.deployProxy(
      await hre.ethers.getContractFactory("IDRPController"),
      [tokenAddr, deployer.address],
      proxyOpts
    );
    await controller.waitForDeployment();
    const ctrlAddr = await controller.getAddress();
    const ctrlImpl = await hre.upgrades.erc1967.getImplementationAddress(ctrlAddr);
    console.log(`      proxy ${ctrlAddr}  impl ${ctrlImpl}`);

    // A controller cannot shorten its own delay without first waiting it out,
    // so a 48h controller on a testnet is a two-day lock. Check before going on.
    const delays = {
      "IDRP.UPGRADE_DELAY": await (token as any).UPGRADE_DELAY(),
      "IDRPController.UPGRADE_DELAY": await (controller as any).UPGRADE_DELAY(),
      "IDRPController.defaultAdminDelay": await (controller as any).defaultAdminDelay(),
    };
    for (const [k, v] of Object.entries(delays)) {
      if (Number(v) !== DELAY_SECONDS) throw new Error(`${k} = ${v}, expected ${DELAY_SECONDS}`);
    }
    await assertDeployedIsBuilt("contracts/IDRP.sol:IDRP", tokenImpl);
    await assertDeployedIsBuilt("contracts/IDRPController.sol:IDRPController", ctrlImpl);
    console.log(`      delays ${DELAY_SECONDS}s on all three; deployed code == build`);

    const builds = {
      IDRP: await buildRecord("contracts/IDRP.sol:IDRP"),
      IDRPController: await buildRecord("contracts/IDRPController.sol:IDRPController"),
    };

    return { token, controller, tokenAddr, ctrlAddr, tokenImpl, ctrlImpl, builds };
  });
  const { token, controller, tokenAddr, ctrlAddr, tokenImpl, ctrlImpl, builds } = built;

  console.log("\n[3/7] Sanctions list");
  let sanctionsList = process.env.SANCTIONS_LIST ?? KNOWN_SANCTIONS_LISTS[chainId];
  if (sanctionsList) {
    if ((await hre.ethers.provider.getCode(sanctionsList)) === "0x") throw new Error(`no code at ${sanctionsList}`);
  } else {
    const list = await (await hre.ethers.getContractFactory("SanctionsList")).deploy();
    await list.waitForDeployment();
    sanctionsList = await list.getAddress();
    console.log(`      deployed a SanctionsList owned by the deployer`);
  }
  console.log(`      ${sanctionsList}`);

  console.log("\n[4/7] Wiring the token");
  await (await (token as any).setDepositoryWallet(DEPOSITORY)).wait();
  await (await (token as any).setSanctionsList(sanctionsList)).wait();
  await (await (token as any).setController(ctrlAddr)).wait();
  console.log(`      depository ${await (token as any).depositoryWallet()}`);
  console.log(`      sanctions  ${await (token as any).sanctionsList()}`);
  console.log(`      controller ${await (token as any).controller()}`);

  console.log("\n[5/7] Quorum roles");
  for (const [role, addr] of Object.entries(QUORUM_SIGNERS)) {
    const hash = hre.ethers.id(role);
    await (await (controller as any).grantRole(hash, addr)).wait();
    if (!(await (controller as any).hasRole(hash, addr))) throw new Error(`${role} not granted to ${addr}`);
    console.log(`      ${role.replace("_ROLE", "").padEnd(13)} ${addr}`);
  }

  console.log("\n[6/7] Quorum rules");
  for (const [op, name, file] of RULE_FILES) {
    const rules = loadRules(op, file);
    await (await (controller as any).setQuorumRules(op, rules)).wait();
    for (const [i, r] of rules.entries()) {
      const live = await (controller as any).getQuorumRule(op, r.minAmount);
      if (
        live.minAmount !== r.minAmount ||
        live.maxAmount !== r.maxAmount ||
        live.requiredRoles.join() !== r.requiredRoles.join()
      ) {
        throw new Error(`${name} tier ${i} reads back differently`);
      }
    }
    console.log(`      op ${op} ${name.padEnd(9)} ${rules.length} tier(s)`);
  }

  console.log("\n[7/7] Test supply");
  if (mintWhole !== "0") {
    // mint() is onlyController: point it at the deployer for one call, then back.
    await (await (token as any).setController(deployer.address)).wait();
    await (await (token as any).mint(hre.ethers.parseUnits(mintWhole, 6))).wait();
    await (await (token as any).setController(ctrlAddr)).wait();
    if ((await (token as any).controller()) !== ctrlAddr) throw new Error("controller was not restored after minting");
  }
  console.log(`      totalSupply ${await (token as any).totalSupply()} (to the depository)`);

  const buildFile = (impl: string) => path.join(recordDir, "builds", String(chainId), `${impl}.json`);
  for (const [impl, record] of [[tokenImpl, builds.IDRP], [ctrlImpl, builds.IDRPController]] as const) {
    fs.mkdirSync(path.dirname(buildFile(impl)), { recursive: true });
    fs.writeFileSync(buildFile(impl), JSON.stringify(record, null, 2) + "\n");
  }
  const rel = (p: string) => (local ? p : path.relative(root, p));
  const record = {
    env: ENV,
    network: hre.network.name,
    chainId,
    sourceCommit: commit,
    delays: Object.fromEntries(DELAY_LINES.map(([f, l]) => [`${path.basename(f, ".sol")}.${l.includes("DEFAULT_ADMIN") ? "DEFAULT_ADMIN_DELAY" : "UPGRADE_DELAY"}`, DELAY_TEXT])),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    IDRP: tokenAddr,
    IDRPController: ctrlAddr,
    IDRPImpl: tokenImpl,
    IDRPControllerImpl: ctrlImpl,
    IDRPBuild: rel(buildFile(tokenImpl)),
    IDRPControllerBuild: rel(buildFile(ctrlImpl)),
    depositoryWallet: DEPOSITORY,
    sanctionsList,
    quorumSigners: QUORUM_SIGNERS,
  };
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");

  console.log("\n─────────────────────────────────────────────────────");
  console.log(`token       ${tokenAddr}   impl ${tokenImpl}`);
  console.log(`controller  ${ctrlAddr}   impl ${ctrlImpl}`);
  console.log(`admin       ${await (token as any).admin()} (deployer)`);
  console.log(`record      ${rel(recordFile)}`);
  console.log(`\nPlatform AppSettings for this chain:`);
  console.log(`  idrpAddress${chainId}        = ${tokenAddr}`);
  console.log(`  controllerAddress${chainId}  = ${ctrlAddr}`);
  if (!local) {
    console.log(`\nCommit the record: git add deployment/${ENV}/chain-${chainId}.json deployment/builds/${chainId}/ .openzeppelin`);
    console.log(`Verify on the explorer: npx hardhat run scripts/verify-testnet-builds.ts --network ${hre.network.name}`);
  }
}

main().catch((e) => {
  console.error("\n" + (e.message ?? e));
  process.exitCode = 1;
});

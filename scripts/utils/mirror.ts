import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Read-only helpers for keeping a testnet identical to the mainnet it mirrors.
 * Nothing here sends a transaction.
 */

/** testnet chainId -> mainnet chainId it mirrors. */
export const MIRROR_OF: Record<number, number> = { 11155111: 1, 97: 56, 80002: 137, 1001: 8217 };

/** Live proxies the testnets mirror (Ethereum, BSC, Polygon, Kaia). */
export const MAINNET_PROXIES: Record<number, { token: string; controller: string }> = {
  1: { token: "0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56", controller: "0x9cB9AE7480ee98A41373100d4304194043f02c9d" },
  56: { token: "0x817d0C3D4e63231d88B2d73217B7fB75b87e0606", controller: "0x466d7B865e394f640aa436a399A464f7dC65C410" },
  137: { token: "0xADb603C1D0a1b3943C9df35a50099f22fEaCaA58", controller: "0x877538747fe8acb657C1a54A759A8e4B9cC987Bc" },
  8217: { token: "0xC16d986585407A74Ab87d17C3d0Dc19822E3EB35", controller: "0xA2A8337eBc5d8553BFa12749eaB6b4bEAAc9137d" },
};

/** Public RPCs used only to read the mainnets. */
export const MAINNET_RPC: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  8217: "https://public-en.node.kaia.io",
};

export const OPS: Array<[number, string, string]> = [
  [0, "Mint", "rules.mint.burn.json"],
  [1, "Burn", "rules.mint.burn.json"],
  [2, "Freeze", "rules.freeze.unfreeze.json"],
  [3, "Unfreeze", "rules.freeze.unfreeze.json"],
  [4, "Pause", "rules.pause.json"],
  [5, "Unpause", "rules.unpause.json"],
];
export const ROLES = ["OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"];
const MAX_UINT = (1n << 256n) - 1n;

export type Tier = { minAmount: string; maxAmount: string; requiredRoles: string[] };
export type ChainConfig = {
  rules: Record<number, Tier[]>;
  maxSupply: string;
  sanctionsList: string;
  tokenUpgradeDelay: string;
  controllerUpgradeDelay: string;
  controllerDefaultAdminDelay: string;
};

const roleName = (hash: string) => ROLES.find((r) => hre.ethers.id(r) === hash) ?? hash;

/** A call that may not exist on an older proxy: report "absent" instead of a made-up value. */
async function tryRead(fn: () => Promise<unknown>): Promise<string> {
  try {
    return String(await fn());
  } catch {
    return "absent";
  }
}

/**
 * Reads the quorum tables and wiring through `runner`. The tiers are walked from
 * amount 0 upwards with getQuorumRule, using each tier's maxAmount as the next
 * probe, so the whole table is read as the chain answers it.
 */
export async function readChainConfig(runner: any, controllerAddr: string, tokenAddr: string): Promise<ChainConfig> {
  const controller = new hre.ethers.Contract(
    controllerAddr,
    [
      "function getQuorumRule(uint8,uint256) view returns (tuple(uint256 minAmount,uint256 maxAmount,bytes32[] requiredRoles))",
      "function UPGRADE_DELAY() view returns (uint256)",
      "function defaultAdminDelay() view returns (uint48)",
    ],
    runner
  );
  const token = new hre.ethers.Contract(
    tokenAddr,
    ["function maxSupply() view returns (uint256)", "function sanctionsList() view returns (address)", "function UPGRADE_DELAY() view returns (uint256)"],
    runner
  );
  const rules: Record<number, Tier[]> = {};
  for (const [op] of OPS) {
    const tiers: Tier[] = [];
    let amount = 0n;
    for (let i = 0; i < 20; i++) {
      const r = await controller.getQuorumRule(op, amount);
      tiers.push({
        minAmount: r.minAmount.toString(),
        maxAmount: r.maxAmount.toString(),
        requiredRoles: [...r.requiredRoles].map((h: string) => roleName(h)),
      });
      if (r.maxAmount >= MAX_UINT) break;
      amount = r.maxAmount;
    }
    rules[op] = tiers;
  }
  return {
    rules,
    maxSupply: await tryRead(() => token.maxSupply()),
    sanctionsList: await tryRead(() => token.sanctionsList()),
    tokenUpgradeDelay: await tryRead(() => token.UPGRADE_DELAY()),
    controllerUpgradeDelay: await tryRead(() => controller.UPGRADE_DELAY()),
    controllerDefaultAdminDelay: await tryRead(() => controller.defaultAdminDelay()),
  };
}

/** The mainnet's own config, read live. */
export async function readMainnet(mainnetChainId: number): Promise<ChainConfig> {
  const p = MAINNET_PROXIES[mainnetChainId];
  const provider = new hre.ethers.JsonRpcProvider(MAINNET_RPC[mainnetChainId], mainnetChainId, { staticNetwork: true });
  return readChainConfig(provider, p.controller, p.token);
}

/**
 * Differences between a deployed testnet and the mainnet it mirrors. The only
 * differences allowed are the ones that are meant to differ: the timelocks
 * (300 s on testnets) and the sanctions list address.
 */
export async function compareToMainnet(
  runner: any,
  testnet: { controller: string; token: string },
  testnetChainId: number,
  delaySeconds = 300
): Promise<string[]> {
  const mirror = MIRROR_OF[testnetChainId];
  if (!mirror) throw new Error(`chain ${testnetChainId} has no mainnet twin`);
  const [mine, theirs] = await Promise.all([readChainConfig(runner, testnet.controller, testnet.token), readMainnet(mirror)]);
  const diffs: string[] = [];
  for (const [op, name] of OPS) {
    if (JSON.stringify(mine.rules[op]) !== JSON.stringify(theirs.rules[op])) {
      diffs.push(`op ${op} ${name}: testnet ${JSON.stringify(mine.rules[op])} != mainnet ${JSON.stringify(theirs.rules[op])}`);
    }
  }
  if (mine.maxSupply !== theirs.maxSupply) diffs.push(`maxSupply: testnet ${mine.maxSupply} != mainnet ${theirs.maxSupply}`);
  for (const [k, v] of [
    ["tokenUpgradeDelay", mine.tokenUpgradeDelay],
    ["controllerUpgradeDelay", mine.controllerUpgradeDelay],
    ["controllerDefaultAdminDelay", mine.controllerDefaultAdminDelay],
  ] as const) {
    if (v !== String(delaySeconds)) diffs.push(`${k}: testnet ${v} != ${delaySeconds}`);
  }
  if (mine.sanctionsList === "absent" || mine.sanctionsList === hre.ethers.ZeroAddress) diffs.push(`sanctionsList is not set`);
  return diffs;
}

/** Fixture tiers with the EVM mainnets' pause role order, for comparing live reads against test/utils. */
export function fixtureTiers(file: string, op: number, pauseOrder = ["DIRECTOR_ROLE", "MANAGER_ROLE"]): Tier[] {
  const raw = JSON.parse(fs.readFileSync(path.join(hre.config.paths.root, "test/utils", file), "utf8"));
  return raw.map((r: any) => ({
    minAmount: String(r.minAmount),
    maxAmount: String(r.maxAmount),
    requiredRoles: op === 4 ? pauseOrder : r.requiredRoles.map((h: string) => roleName(h)),
  }));
}

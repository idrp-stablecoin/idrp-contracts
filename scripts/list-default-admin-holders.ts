import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * scripts/list-default-admin-holders.ts
 *
 * Enumerate addresses that currently hold DEFAULT_ADMIN_ROLE on the
 * IDRPController proxy for this chain.
 *
 * Why this script exists:
 * The Controller currently uses plain AccessControlUpgradeable (v2 source).
 * The v2 → v3 migration switches to AccessControlDefaultAdminRulesUpgradeable
 * (ACDAR), which enforces a strict "exactly one DEFAULT_ADMIN_ROLE holder at a
 * time" invariant. To honor that invariant safely, `initializeV3` revokes
 * every existing legacy DEFAULT_ADMIN_ROLE holder BEFORE granting the new
 * one through ACDAR's init — see docs/design/no-defaultadmin-leftbehind.md.
 *
 * Plain AccessControl can't enumerate role holders on-chain, so we replay
 * RoleGranted / RoleRevoked events from proxy deployment to latest block,
 * filter by `role == DEFAULT_ADMIN_ROLE (bytes32(0))`, and compute the
 * current holder set.
 *
 * Output: deployment/chain-{chainId}-legacy-default-admin-holders.json
 * Consumed by: the Controller v2 → v3 migration step (passed as the
 *              _legacyDefaultAdminHolders argument to initializeV3).
 *
 * Safety: we pass the set of *currently* held addresses (Granted minus
 * Revoked) rather than every address that was ever granted. A revoked
 * address has `_roles[role][account] = false` already.
 *
 * Usage:
 *   npx hardhat run scripts/list-default-admin-holders.ts --network <name>
 */

const DEFAULT_ADMIN_ROLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );
  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`);
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }
  const deployments: Record<string, string> = JSON.parse(
    fs.readFileSync(deploymentFile, "utf-8")
  );
  const proxyAddress = deployments.IDRPController;
  if (!proxyAddress) {
    throw new Error("IDRPController proxy address not found in deployment file");
  }

  const iface = new hre.ethers.Interface([
    "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
    "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  ]);

  const provider = hre.ethers.provider;
  const latestBlock = await provider.getBlockNumber();
  const grantedTopic = iface.getEvent("RoleGranted")!.topicHash;
  const revokedTopic = iface.getEvent("RoleRevoked")!.topicHash;

  console.log(`Chain: ${networkId}`);
  console.log(`Proxy: ${proxyAddress}`);
  console.log(`Role:  DEFAULT_ADMIN_ROLE (${DEFAULT_ADMIN_ROLE})`);
  console.log(`Scanning 0..${latestBlock} for role events...`);

  const CHUNK = 50_000;
  const grantedLogs: any[] = [];
  const revokedLogs: any[] = [];
  for (let from = 0; from <= latestBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latestBlock);
    const [g, r] = await Promise.all([
      provider.getLogs({
        address: proxyAddress,
        fromBlock: from,
        toBlock: to,
        topics: [grantedTopic, DEFAULT_ADMIN_ROLE],
      }),
      provider.getLogs({
        address: proxyAddress,
        fromBlock: from,
        toBlock: to,
        topics: [revokedTopic, DEFAULT_ADMIN_ROLE],
      }),
    ]);
    grantedLogs.push(...g);
    revokedLogs.push(...r);
  }

  type Event = {
    type: "granted" | "revoked";
    account: string;
    block: number;
    tx: number;
  };
  const events: Event[] = [];
  for (const log of grantedLogs) {
    const parsed = iface.parseLog(log);
    events.push({
      type: "granted",
      account: hre.ethers.getAddress(parsed!.args.account),
      block: log.blockNumber,
      tx: log.transactionIndex,
    });
  }
  for (const log of revokedLogs) {
    const parsed = iface.parseLog(log);
    events.push({
      type: "revoked",
      account: hre.ethers.getAddress(parsed!.args.account),
      block: log.blockNumber,
      tx: log.transactionIndex,
    });
  }
  events.sort((a, b) => a.block - b.block || a.tx - b.tx);

  const holders = new Set<string>();
  for (const ev of events) {
    if (ev.type === "granted") holders.add(ev.account);
    else holders.delete(ev.account);
  }

  const out = Array.from(holders);
  console.log(
    `\nCurrent DEFAULT_ADMIN_ROLE holders on chain ${networkId}: ${out.length}`
  );
  out.forEach((a) => console.log(`  - ${a}`));

  const outFile = path.join(
    deploymentDir,
    `chain-${networkId}-legacy-default-admin-holders.json`
  );
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWritten: ${outFile}`);
  console.log(
    `Pass this list as the _legacyDefaultAdminHolders argument to ` +
      `Controller.initializeV3(...).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

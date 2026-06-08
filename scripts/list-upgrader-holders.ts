import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Enumerate addresses that currently hold the legacy UPGRADER_ROLE on the IDRP
 * proxy for this chain.
 *
 * Why this script exists:
 * IDRP uses plain AccessControlUpgradeable (NOT the Enumerable variant), so the
 * contract cannot list role holders on-chain. We replay RoleGranted /
 * RoleRevoked events from proxy deployment to latest block, filter by
 * `role == keccak256("UPGRADER_ROLE")`, and compute the current holder set.
 *
 * Output is written to `deployment/chain-{chainId}-legacy-upgrader-holders.json`
 * and consumed by `scripts/upgrade.ts` when migrating a v1 proxy to v2 via
 * initializeV2, which revokes each listed address to clean up stale role state.
 *
 * Safety: we pass the set of *currently* held addresses (Granted minus Revoked)
 * rather than every address that was ever granted. A revoked address has
 * `_roles[role][account] = false` already, so there's nothing to clean up.
 */
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
  const proxyAddress = deployments["IDRP"];
  if (!proxyAddress) {
    throw new Error("IDRP proxy address not found in deployment file");
  }

  const UPGRADER_ROLE = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("UPGRADER_ROLE")
  );

  // Build a minimal interface so we can query events even after the constant
  // `UPGRADER_ROLE` has been removed from the current contract source.
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
  console.log(`Role:  UPGRADER_ROLE (${UPGRADER_ROLE})`);
  // Per-chain deployment-block hints reduce the scan range from "whole chain"
  // to "from proxy creation" — essential on chains like Kairos with 200M+ blocks.
  // Add new entries as you onboard chains.
  const PROXY_DEPLOY_BLOCK: Record<number, Record<string, number>> = {
    1001: {
      // Kaia Kairos IDRP — deploy tx
      // https://kairos.kaiascan.io/tx/0x7f8ab3ff9971447364bbd5203ff55b04bc337f55a5311361e8720e58fbd79e51
      "0x999f947F3c7C0cF64AE53571a7fda51ce7f66164": 212_900_397,
    },
  };
  const startBlock =
    PROXY_DEPLOY_BLOCK[networkId]?.[proxyAddress] ?? 0;
  console.log(
    `Scanning ${startBlock}..${latestBlock} for role events (range: ${latestBlock - startBlock})...`
  );

  // Chunked getLogs with adaptive shrinking — RPCs cap range and/or rate.
  let chunk = 50_000;
  const grantedLogs: any[] = [];
  const revokedLogs: any[] = [];
  let from = startBlock;
  while (from <= latestBlock) {
    const to = Math.min(from + chunk - 1, latestBlock);
    try {
      const [g, r] = await Promise.all([
        provider.getLogs({
          address: proxyAddress,
          fromBlock: from,
          toBlock: to,
          topics: [grantedTopic, UPGRADER_ROLE],
        }),
        provider.getLogs({
          address: proxyAddress,
          fromBlock: from,
          toBlock: to,
          topics: [revokedTopic, UPGRADER_ROLE],
        }),
      ]);
      grantedLogs.push(...g);
      revokedLogs.push(...r);
      from = to + 1;
    } catch (e) {
      if (chunk <= 1_000) {
        throw new Error(
          `getLogs failed even at chunk=${chunk} starting block ${from}: ${(e as Error).message}`
        );
      }
      chunk = Math.floor(chunk / 5);
      console.log(`  RPC rejected; shrinking chunk to ${chunk}`);
    }
  }

  // Replay events in chronological order, tracking the running holder set.
  type Event = { type: "granted" | "revoked"; account: string; block: number; tx: number };
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
  console.log(`\nCurrent UPGRADER_ROLE holders on chain ${networkId}: ${out.length}`);
  out.forEach((a) => console.log(`  - ${a}`));

  const outFile = path.join(
    deploymentDir,
    `chain-${networkId}-legacy-upgrader-holders.json`
  );
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWritten: ${outFile}`);
  console.log(`Use this file with scripts/upgrade.ts to run the v1 → v2 migration.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

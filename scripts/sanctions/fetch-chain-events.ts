/**
 * Reconstruct the current sanctioned-address set from a SanctionsList contract
 * by replaying its on-chain events, then write a JSON snapshot to
 * scripts/sanctions/results/.
 *
 * Two ways to read the events:
 *   1. Etherscan v2 logs API (DEFAULT when ETHERSCAN_API_KEY is set and the
 *      chain is Etherscan-supported). Free tier, no block-range limits, handles
 *      Ethereum / BSC / Polygon / Base / Base Sepolia / Optimism / Arbitrum /
 *      Avalanche under one API key.
 *   2. Direct RPC eth_getLogs with adaptive batch (FALLBACK). Used for chains
 *      Etherscan doesn't index (Kaia, custom networks). Halves the block range
 *      on "exceeds limit" errors.
 *
 * Why this script exists
 * ──────────────────────
 * The sanctioned mapping is `private`, so you can't just call a getter to dump
 * the list. The only way to read the current state is to replay every write
 * event (`SanctionedAddressesAdded`, `SanctionedAddressesRemoved`) in
 * chronological order and walk the resulting set.
 *
 * `SanctionedAddress` and `NonSanctionedAddress` events are deliberately ignored
 * — they're emitted by `isSanctionedVerbose` reads, not state changes.
 *
 * Where Chainalysis is deployed (CREATE2'd at the same address everywhere):
 *   0x40C57923924B5c5c5455c48D93317139ADDaC8fb on:
 *     · Ethereum mainnet  (chainid 1)
 *     · BSC               (chainid 56)
 *     · Polygon           (chainid 137)
 *     · Avalanche         (chainid 43114)
 *     · Optimism          (chainid 10)
 *     · Arbitrum One      (chainid 42161)
 *   NOT on Base, NOT on any testnet, NOT on Kaia/Tron.
 *
 * Usage
 * ─────
 *   # Read the real Chainalysis oracle on Ethereum mainnet (uses Etherscan):
 *   npx hardhat run scripts/sanctions/fetch-chain-events.ts --network mainnet
 *
 *   # Read our own deployment on Kaia testnet (falls back to RPC):
 *   SANCTIONS_CONTRACT_ADDRESS=0x... \
 *     npx hardhat run scripts/sanctions/fetch-chain-events.ts --network kairos
 *
 *   # Force the RPC path even when Etherscan is available (debugging):
 *   USE_RPC=1 npx hardhat run scripts/sanctions/fetch-chain-events.ts --network mainnet
 *
 *   # Optional: limit block range (defaults to genesis → latest):
 *   FROM_BLOCK=14000000 TO_BLOCK=14500000 npx hardhat run ...
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";
import { ethers } from "ethers";
import { vars } from "hardhat/config";
import type { EventLog, Log } from "ethers";
import type { SanctionsList } from "../../typechain-types";

// Default to Chainalysis's CREATE2 address — works on every chain they support.
// Override via SANCTIONS_CONTRACT_ADDRESS env var when reading our own clone.
const CHAINALYSIS_ADDRESS = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";

// Chains where Etherscan v2 indexes contract logs.
const ETHERSCAN_SUPPORTED_CHAINS = new Set<number>([
  1,        // Ethereum mainnet
  11155111, // Sepolia
  17000,    // Holesky
  56,       // BSC
  97,       // BSC testnet
  137,      // Polygon
  80002,    // Polygon Amoy
  8453,     // Base
  84532,    // Base Sepolia
  10,       // Optimism
  11155420, // OP Sepolia
  42161,    // Arbitrum One
  421614,   // Arbitrum Sepolia
  43114,    // Avalanche
]);

// Event topic0s — keccak256 of the event signature.
const TOPIC_ADDED = ethers.id("SanctionedAddressesAdded(address[])");
const TOPIC_REMOVED = ethers.id("SanctionedAddressesRemoved(address[])");

// Used for decoding raw logs from the Etherscan API.
const EVENT_IFACE = new ethers.Interface([
  "event SanctionedAddressesAdded(address[] addrs)",
  "event SanctionedAddressesRemoved(address[] addrs)",
]);

interface Snapshot {
  fetchedAt: string;
  enabledSources: string[];
  stats: {
    sourceChain: string;
    sourceContract: string;
    fromBlock: number;
    toBlock: number;
    addEventCount: number;
    removeEventCount: number;
    totalAddOperations: number;
    totalRemoveOperations: number;
    currentlySanctioned: number;
    fetchPath: "etherscan" | "rpc";
  };
  addresses: string[];
}

interface NormalizedEvent {
  blockNumber: number;
  logIndex: number;
  eventName: "SanctionedAddressesAdded" | "SanctionedAddressesRemoved";
  addresses: string[];
}

// ─── Etherscan v2 path ────────────────────────────────────────────────────────

async function fetchLogsViaEtherscan(
  chainId: number,
  contractAddr: string,
  topic0: string,
  fromBlock: number,
  toBlock: number,
  apiKey: string
): Promise<NormalizedEvent[]> {
  const eventName =
    topic0 === TOPIC_ADDED ? "SanctionedAddressesAdded" : "SanctionedAddressesRemoved";
  const out: NormalizedEvent[] = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const url =
      `https://api.etherscan.io/v2/api` +
      `?chainid=${chainId}` +
      `&module=logs&action=getLogs` +
      `&address=${contractAddr}` +
      `&topic0=${topic0}` +
      `&fromBlock=${cursor}&toBlock=${toBlock}` +
      `&page=1&offset=1000` +
      `&apikey=${apiKey}`;

    const r = await fetch(url);
    const body = (await r.json()) as { status: string; message: string; result: unknown };

    if (body.status === "0") {
      const msg = String(body.message ?? "");
      if (msg === "No records found") return out; // empty page = done
      throw new Error(`Etherscan: ${msg} ${JSON.stringify(body.result)}`);
    }
    if (body.status !== "1" || !Array.isArray(body.result)) {
      throw new Error(`Etherscan: unexpected response ${JSON.stringify(body)}`);
    }

    const page = body.result as Array<{
      blockNumber: string;
      logIndex: string;
      topics: string[];
      data: string;
    }>;
    for (const log of page) {
      const decoded = EVENT_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (!decoded) continue;
      out.push({
        blockNumber: parseInt(log.blockNumber, 16),
        logIndex: parseInt(log.logIndex, 16),
        eventName,
        addresses: decoded.args[0] as string[],
      });
    }

    if (page.length < 1000) break; // last page
    // Etherscan returns max 1000 per call; advance past the highest block we just got.
    const lastBlock = parseInt(page[page.length - 1].blockNumber, 16);
    cursor = lastBlock + 1;
    process.stdout.write(`\r  [etherscan] ${eventName}: ${out.length} events (cursor at block ${cursor})  `);
  }
  return out;
}

// ─── RPC fallback path with adaptive batching ────────────────────────────────

const STATE_CHANGE_RANGE_HINTS = ["range", "limit", "block range", "exceed", "too many"];

async function fetchLogsViaRPC(
  list: SanctionsList,
  topic0: string,
  fromBlock: number,
  toBlock: number,
  startBatchSize: number
): Promise<NormalizedEvent[]> {
  const eventName =
    topic0 === TOPIC_ADDED ? "SanctionedAddressesAdded" : "SanctionedAddressesRemoved";
  const filter =
    topic0 === TOPIC_ADDED
      ? list.filters.SanctionedAddressesAdded()
      : list.filters.SanctionedAddressesRemoved();

  const out: NormalizedEvent[] = [];
  let batch = startBatchSize;
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(start + batch - 1, toBlock);
    try {
      const events = (await list.queryFilter(filter, start, end)) as (EventLog | Log)[];
      for (const ev of events) {
        if (!("args" in ev)) continue;
        out.push({
          blockNumber: ev.blockNumber,
          logIndex: ev.index,
          eventName,
          addresses: (ev.args[0] as string[]) ?? [],
        });
      }
      start = end + 1;
      process.stdout.write(
        `\r  [rpc] ${eventName}: blocks ${start.toString().padStart(10)} (batch ${batch}) · ${out.length} events  `
      );
    } catch (err) {
      const msg = String((err as Error).message ?? err).toLowerCase();
      const looksLikeRangeLimit = STATE_CHANGE_RANGE_HINTS.some((h) => msg.includes(h));
      if (looksLikeRangeLimit && batch > 1) {
        const next = Math.max(1, Math.floor(batch / 4));
        process.stdout.write(`\r  [rpc] range too wide (batch=${batch}) → shrinking to ${next}                           \n`);
        batch = next;
        continue;
      }
      throw err;
    }
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readEtherscanKey(): string | undefined {
  // Prefer env, fall back to hardhat vars where the project keeps it.
  if (process.env.ETHERSCAN_API_KEY) return process.env.ETHERSCAN_API_KEY;
  try {
    const v = vars.get("ETHERSCAN_API_KEY");
    return v && v !== "unnecessary" ? v : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const contractAddr = hre.ethers.getAddress(
    process.env.SANCTIONS_CONTRACT_ADDRESS ?? CHAINALYSIS_ADDRESS
  );
  const chainId = Number(hre.network.config.chainId ?? 0);
  const networkName = hre.network.name;

  const fromBlock = Number(process.env.FROM_BLOCK ?? 0);
  const tip = Number(await hre.ethers.provider.getBlockNumber());
  const toBlock = process.env.TO_BLOCK ? Number(process.env.TO_BLOCK) : tip;

  const etherscanKey = readEtherscanKey();
  const useEtherscan =
    !process.env.USE_RPC &&
    etherscanKey !== undefined &&
    ETHERSCAN_SUPPORTED_CHAINS.has(chainId);

  console.log(`network            : ${networkName} (chainId ${chainId})`);
  console.log(`contract           : ${contractAddr}`);
  console.log(`block range        : ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1} blocks)`);
  console.log(`fetch path         : ${useEtherscan ? "Etherscan v2 (free tier)" : "RPC eth_getLogs (adaptive batch)"}`);
  if (!useEtherscan && etherscanKey === undefined) {
    console.log(`  hint             : set ETHERSCAN_API_KEY (vars or env) to use the faster Etherscan path`);
  }
  if (!useEtherscan && !ETHERSCAN_SUPPORTED_CHAINS.has(chainId)) {
    console.log(`  note             : chainId ${chainId} not in Etherscan v2 — using RPC`);
  }
  console.log("");

  let added: NormalizedEvent[] = [];
  let removed: NormalizedEvent[] = [];

  if (useEtherscan) {
    console.log("→ pulling SanctionedAddressesAdded via Etherscan...");
    added = await fetchLogsViaEtherscan(chainId, contractAddr, TOPIC_ADDED, fromBlock, toBlock, etherscanKey!);
    console.log(`\n  added events: ${added.length}`);

    console.log("→ pulling SanctionedAddressesRemoved via Etherscan...");
    removed = await fetchLogsViaEtherscan(chainId, contractAddr, TOPIC_REMOVED, fromBlock, toBlock, etherscanKey!);
    console.log(`\n  removed events: ${removed.length}`);
  } else {
    const list = (await hre.ethers.getContractAt(
      "SanctionsList",
      contractAddr
    )) as unknown as SanctionsList;

    console.log("→ pulling SanctionedAddressesAdded via RPC...");
    added = await fetchLogsViaRPC(list, TOPIC_ADDED, fromBlock, toBlock, 9_999);
    console.log(`\n  added events: ${added.length}`);

    console.log("→ pulling SanctionedAddressesRemoved via RPC...");
    removed = await fetchLogsViaRPC(list, TOPIC_REMOVED, fromBlock, toBlock, 9_999);
    console.log(`\n  removed events: ${removed.length}`);
  }

  console.log("→ replaying events in chronological order...");

  const merged = [...added, ...removed].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  const state = new Set<string>();
  let totalAddOperations = 0;
  let totalRemoveOperations = 0;
  for (const ev of merged) {
    if (ev.eventName === "SanctionedAddressesAdded") {
      for (const a of ev.addresses) state.add(hre.ethers.getAddress(a));
      totalAddOperations += ev.addresses.length;
    } else {
      for (const a of ev.addresses) state.delete(hre.ethers.getAddress(a));
      totalRemoveOperations += ev.addresses.length;
    }
  }

  console.log(`  resolved set: ${state.size} currently sanctioned`);
  console.log("");

  const snapshot: Snapshot = {
    fetchedAt: new Date().toISOString(),
    enabledSources: [`chain:${networkName}:${contractAddr}`],
    stats: {
      sourceChain: networkName,
      sourceContract: contractAddr,
      fromBlock,
      toBlock,
      addEventCount: added.length,
      removeEventCount: removed.length,
      totalAddOperations,
      totalRemoveOperations,
      currentlySanctioned: state.size,
      fetchPath: useEtherscan ? "etherscan" : "rpc",
    },
    addresses: Array.from(state).sort(),
  };

  const outDir =
    process.env.FETCH_OUTPUT_DIR ??
    path.join(hre.config.paths.root || process.cwd(), "scripts/sanctions/results");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const tsSafe = snapshot.fetchedAt.replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `chain-${networkName}-${tsSafe}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`✓ snapshot written to ${outPath}`);
  if (state.size === 0) {
    console.log("");
    console.log("⚠️  zero sanctioned addresses — common causes:");
    console.log(`   · the contract isn't deployed on this chain (Chainalysis is mainnet-only and not on Base/testnets)`);
    console.log(`   · no events have fired yet (your own clone, freshly deployed)`);
    console.log(`   · wrong contract address`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  · feed this snapshot into the seeder to mirror it onto another chain:");
  console.log(`    SANCTIONS_LIST_ADDRESS=0x...<our list> \\`);
  console.log(`    SANCTIONS_SNAPSHOT_PATH=${outPath} \\`);
  console.log(`    APPLY=1 npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network <chain>`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

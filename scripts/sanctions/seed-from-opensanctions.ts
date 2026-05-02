/**
 * Apply a sanctions snapshot to SanctionsList on-chain.
 *
 * Reads a snapshot JSON produced by `fetch-opensanctions.ts`, diffs it against
 * the current on-chain state (reconstructed from events), and submits only the
 * actual changes — chunked at MAX_BATCH (default 500).
 *
 * SCOPE — sandbox milestone, per WhatsApp 2026-05-02:
 *   This is a MANUAL-RUN tool, not a long-lived daemon.
 *
 * USAGE:
 *   # 1) Fetch a snapshot (no chain access — writes JSON to scripts/sanctions/results/):
 *   npx hardhat run scripts/sanctions/fetch-opensanctions.ts
 *
 *   # 2) Apply that snapshot. Dry-run by default:
 *   SANCTIONS_LIST_ADDRESS=0x... \
 *   SANCTIONS_SNAPSHOT_PATH=scripts/sanctions/results/<timestamp>.json \
 *   npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network kairos
 *
 *   # 3) Apply for real (sends txs):
 *   SANCTIONS_LIST_ADDRESS=0x... \
 *   SANCTIONS_SNAPSHOT_PATH=scripts/sanctions/results/<timestamp>.json \
 *   APPLY=1 \
 *   npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network kairos
 *
 *   If SANCTIONS_SNAPSHOT_PATH is omitted, the most recent .json file in
 *   scripts/sanctions/results/ is used.
 *
 * DIFF RULE (critical):
 *   Re-pushing the entire desired state every cycle still costs ~5k gas/entry
 *   (non-zero → non-zero SSTORE). For 10k addresses that's ~$10/cycle on Kaia
 *   wasted. Compute deltas only:
 *     toAdd     — addresses in snapshot, not yet on-chain
 *     toRemove  — addresses on-chain, no longer in snapshot
 *   and submit only those, chunked at MAX_BATCH.
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";
import type { SanctionsList } from "../../typechain-types";

const MAX_BATCH = 500;

// ─── Snapshot loader ─────────────────────────────────────────────────────────

interface Snapshot {
  fetchedAt: string;
  enabledSources: string[];
  stats: Record<string, number>;
  addresses: string[];
}

/**
 * Resolves the snapshot file. Honors SANCTIONS_SNAPSHOT_PATH if set; otherwise
 * picks the most recent .json file in scripts/sanctions/results/.
 */
function resolveSnapshotPath(): string {
  const explicit = process.env.SANCTIONS_SNAPSHOT_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`SANCTIONS_SNAPSHOT_PATH=${explicit} does not exist.`);
    }
    return explicit;
  }

  const resultsDir = path.join(hre.config.paths.root || process.cwd(), "scripts/sanctions/results");
  if (!fs.existsSync(resultsDir)) {
    throw new Error(
      `No SANCTIONS_SNAPSHOT_PATH set and no snapshot dir at ${resultsDir}. ` +
        `Run scripts/sanctions/fetch-opensanctions.ts first.`
    );
  }

  const candidates = fs
    .readdirSync(resultsDir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => path.join(resultsDir, n))
    .sort(); // ISO-timestamp filenames sort chronologically
  if (candidates.length === 0) {
    throw new Error(`No .json snapshots in ${resultsDir}. Run fetch-opensanctions.ts first.`);
  }
  return candidates[candidates.length - 1];
}

function loadSnapshot(snapshotPath: string): Snapshot {
  const raw = fs.readFileSync(snapshotPath, "utf-8");
  const parsed = JSON.parse(raw) as Snapshot;
  // Normalize defensively — checksum every address.
  parsed.addresses = parsed.addresses.map((a) => hre.ethers.getAddress(a));
  return parsed;
}

// ─── On-chain state reconstruction ───────────────────────────────────────────

/**
 * Reads the current sanctioned set by replaying the SanctionsList events.
 * More reliable than maintaining off-chain mirror state, and reproducible
 * across operators / machines.
 */
async function readOnChainSet(list: SanctionsList): Promise<Set<string>> {
  const fromBlock = 0; // tighten in production — store deploy block in deployment metadata
  const toBlock = "latest" as const;

  const addedFilter = list.filters.SanctionedAddressesAdded();
  const removedFilter = list.filters.SanctionedAddressesRemoved();

  const [addedEvents, removedEvents] = await Promise.all([
    list.queryFilter(addedFilter, fromBlock, toBlock),
    list.queryFilter(removedFilter, fromBlock, toBlock),
  ]);

  // Merge in chronological order so the latest event wins per address.
  const allEvents = [...addedEvents, ...removedEvents].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.index - b.index;
  });

  const state = new Set<string>();
  for (const ev of allEvents) {
    const addrs = ev.args[0] as string[];
    if (ev.eventName === "SanctionedAddressesAdded") {
      for (const a of addrs) state.add(hre.ethers.getAddress(a));
    } else if (ev.eventName === "SanctionedAddressesRemoved") {
      for (const a of addrs) state.delete(hre.ethers.getAddress(a));
    }
  }
  return state;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

interface Diff {
  toAdd: string[];
  toRemove: string[];
}

function computeDiff(desired: string[], current: Set<string>): Diff {
  const desiredSet = new Set(desired);
  const toAdd: string[] = [];
  const toRemove: string[] = [];

  for (const a of desiredSet) if (!current.has(a)) toAdd.push(a);
  for (const a of current) if (!desiredSet.has(a)) toRemove.push(a);

  return { toAdd, toRemove };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function apply(list: SanctionsList, diff: Diff, dryRun: boolean): Promise<bigint> {
  let totalGas = 0n;

  for (const batch of chunk(diff.toAdd, MAX_BATCH)) {
    console.log(`  + ${batch.length} addr  add`);
    if (!dryRun) {
      const tx = await list.addToSanctionsList(batch);
      const r = await tx.wait();
      if (r) totalGas += r.gasUsed;
    }
  }

  for (const batch of chunk(diff.toRemove, MAX_BATCH)) {
    console.log(`  - ${batch.length} addr  remove`);
    if (!dryRun) {
      const tx = await list.removeFromSanctionsList(batch);
      const r = await tx.wait();
      if (r) totalGas += r.gasUsed;
    }
  }

  return totalGas;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const listAddr = process.env.SANCTIONS_LIST_ADDRESS;
  if (!listAddr) throw new Error("Set SANCTIONS_LIST_ADDRESS in env.");

  const apply_ = process.env.APPLY === "1";
  const [signer] = await hre.ethers.getSigners();

  const snapshotPath = resolveSnapshotPath();
  const snapshot = loadSnapshot(snapshotPath);

  console.log(`network        : ${hre.network.name}`);
  console.log(`list           : ${listAddr}`);
  console.log(`signer         : ${signer.address}`);
  console.log(`mode           : ${apply_ ? "APPLY" : "DRY-RUN"}`);
  console.log(`snapshot       : ${snapshotPath}`);
  console.log(`  fetchedAt    : ${snapshot.fetchedAt}`);
  console.log(`  sources      : ${snapshot.enabledSources.join(", ")}`);
  console.log(`  addresses    : ${snapshot.addresses.length}`);
  console.log("");

  const list = (await hre.ethers.getContractAt(
    "SanctionsList",
    listAddr
  )) as unknown as SanctionsList;

  console.log("→ reconstructing on-chain state from events...");
  const current = await readOnChainSet(list);
  console.log(`  on-chain: ${current.size}`);

  console.log("→ computing diff...");
  const diff = computeDiff(snapshot.addresses, current);
  console.log(`  toAdd: ${diff.toAdd.length}  toRemove: ${diff.toRemove.length}`);

  console.log("");
  console.log(apply_ ? "→ applying..." : "→ dry-run (set APPLY=1 to send txs)");
  const totalGas = await apply(list, diff, !apply_);

  console.log("");
  console.log(`done. total gas used: ${totalGas.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

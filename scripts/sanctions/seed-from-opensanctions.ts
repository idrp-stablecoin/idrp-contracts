/**
 * Apply a sanctions snapshot to IDRPSanctionsRegistry on-chain.
 *
 * Reads a snapshot JSON produced by `fetch-opensanctions.ts`, diffs it against
 * the current on-chain state (reconstructed from events), and submits only the
 * actual changes — chunked by MAX_BATCH_SIZE (500).
 *
 * SCOPE — sandbox milestone, per WhatsApp 2026-05-01:
 *   This is a MANUAL-RUN tool, not a long-lived daemon.
 *
 * USAGE:
 *   # 1) Fetch a snapshot (no chain access — writes JSON to scripts/sanctions/results/):
 *   npx hardhat run scripts/sanctions/fetch-opensanctions.ts
 *
 *   # 2) Apply that snapshot. Dry-run by default:
 *   SANCTIONS_REGISTRY_ADDRESS=0x... \
 *   SANCTIONS_SNAPSHOT_PATH=scripts/sanctions/results/<timestamp>.json \
 *   npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network baseSepolia
 *
 *   # 3) Apply for real (sends txs):
 *   SANCTIONS_REGISTRY_ADDRESS=0x... \
 *   SANCTIONS_SNAPSHOT_PATH=scripts/sanctions/results/<timestamp>.json \
 *   APPLY=1 \
 *   npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network baseSepolia
 *
 *   If SANCTIONS_SNAPSHOT_PATH is omitted, the most recent .json file in
 *   scripts/sanctions/results/ is used.
 *
 * DIFF RULE (critical):
 *   Re-pushing the entire desired state every cycle wastes ~50k gas/entry.
 *   This script computes only:
 *     toAdd     — addresses in snapshot, not yet on-chain
 *     toRemove  — addresses on-chain, no longer in snapshot
 *     toUpdate  — addresses present in both but with mismatched category
 *   and submits only those, chunked by MAX_BATCH_SIZE (500).
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";
import type { IDRPSanctionsRegistry } from "../../typechain-types";

// ─── Source policy ────────────────────────────────────────────────────────────

type SourceKey =
  | "il_nbctf"
  | "uk_hmt"
  | "jp_mof"
  | "fr_freezing"
  | "fbi_lazarus"
  | "ransomwhere"
  | "stablecoin_chain_blacklist"
  | "us_ofac_sdn";

const SOURCE_CATEGORY: Record<SourceKey, number> = {
  il_nbctf: 6, // CAT_FOREIGN_GOV_LIST
  uk_hmt: 6,
  jp_mof: 6,
  fr_freezing: 6,
  fbi_lazarus: 4, // CAT_CRIMINAL_SCAM_THEFT
  ransomwhere: 3, // CAT_CRIMINAL_RANSOMWARE
  stablecoin_chain_blacklist: 4,
  us_ofac_sdn: 8, // CAT_OFAC_SDN
};

const SOURCE_LABEL: Record<SourceKey, string> = {
  il_nbctf: "OpenSanctions:IL_NBCTF",
  uk_hmt: "OpenSanctions:UK_HMT",
  jp_mof: "OpenSanctions:JP_MOF",
  fr_freezing: "OpenSanctions:FR_FREEZING",
  fbi_lazarus: "OpenSanctions:FBI_LAZARUS",
  ransomwhere: "OpenSanctions:ransomwhe.re",
  stablecoin_chain_blacklist: "OpenSanctions:on_chain_blacklist",
  us_ofac_sdn: "OpenSanctions:US_OFAC_SDN",
};

const MAX_BATCH = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceEntry {
  address: string; // checksummed EVM address
  source: SourceKey;
}

interface OnChainEntry {
  address: string;
  category: number;
  source: string;
}

// ─── Snapshot loader ─────────────────────────────────────────────────────────

interface Snapshot {
  fetchedAt: string;
  enabledSources: SourceKey[];
  stats: Record<string, number>;
  entries: SourceEntry[];
}

/**
 * Resolves the snapshot file to load. Honors SANCTIONS_SNAPSHOT_PATH if set;
 * otherwise picks the most recent .json file in scripts/sanctions/results/.
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
    throw new Error(
      `No .json snapshots in ${resultsDir}. Run fetch-opensanctions.ts first.`
    );
  }
  return candidates[candidates.length - 1];
}

function loadSnapshot(snapshotPath: string): Snapshot {
  const raw = fs.readFileSync(snapshotPath, "utf-8");
  const parsed = JSON.parse(raw) as Snapshot;

  // Normalize addresses defensively — the snapshot SHOULD already be checksummed
  // but we don't want a malformed file to silently misroute updates.
  for (const e of parsed.entries) {
    e.address = hre.ethers.getAddress(e.address);
  }
  return parsed;
}

// ─── On-chain state reconstruction ────────────────────────────────────────────

/**
 * Reads the current sanctioned set from the registry by replaying the
 * `SanctionedAddressAdded` and `SanctionedAddressRemoved` events.
 *
 * This is more reliable than maintaining off-chain mirror state, and works
 * across script reruns / different operator machines.
 */
async function readOnChainEntries(registry: IDRPSanctionsRegistry): Promise<Map<string, OnChainEntry>> {
  const fromBlock = 0; // tighten this in production — store the deploy block in deployment metadata
  const toBlock = "latest" as const;

  const addedFilter = registry.filters.SanctionedAddressAdded();
  const removedFilter = registry.filters.SanctionedAddressRemoved();

  const [addedEvents, removedEvents] = await Promise.all([
    registry.queryFilter(addedFilter, fromBlock, toBlock),
    registry.queryFilter(removedFilter, fromBlock, toBlock),
  ]);

  const state = new Map<string, OnChainEntry>();

  // Walk in block/log order so the latest event for an address wins.
  const allEvents = [...addedEvents, ...removedEvents].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.index - b.index;
  });

  for (const ev of allEvents) {
    if (ev.eventName === "SanctionedAddressAdded") {
      const addr = hre.ethers.getAddress(ev.args[0]);
      const category = Number(ev.args[1]);
      const source = ev.args[2] as string;
      state.set(addr, { address: addr, category, source });
    } else if (ev.eventName === "SanctionedAddressRemoved") {
      const addr = hre.ethers.getAddress(ev.args[0]);
      state.delete(addr);
    }
  }

  return state;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

interface Diff {
  toAdd: Map<SourceKey, string[]>; // grouped by source so each batch tags one category
  toRemove: string[];
  toUpdate: Map<SourceKey, string[]>; // present in both, but on-chain category mismatches source
}

function computeDiff(desired: SourceEntry[], current: Map<string, OnChainEntry>): Diff {
  const desiredMap = new Map<string, SourceKey>();
  for (const e of desired) {
    if (!desiredMap.has(e.address)) desiredMap.set(e.address, e.source);
  }

  const toAdd = new Map<SourceKey, string[]>();
  const toUpdate = new Map<SourceKey, string[]>();

  for (const [addr, source] of desiredMap) {
    const onChain = current.get(addr);
    const expectedCategory = SOURCE_CATEGORY[source];
    if (!onChain) {
      pushTo(toAdd, source, addr);
    } else if (onChain.category !== expectedCategory) {
      pushTo(toUpdate, source, addr);
    }
  }

  const toRemove: string[] = [];
  for (const addr of current.keys()) {
    if (!desiredMap.has(addr)) toRemove.push(addr);
  }

  return { toAdd, toRemove, toUpdate };
}

function pushTo(m: Map<SourceKey, string[]>, k: SourceKey, v: string): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// ─── Apply ────────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function apply(registry: IDRPSanctionsRegistry, diff: Diff, dryRun: boolean): Promise<bigint> {
  let totalGas = 0n;

  for (const [source, addrs] of diff.toAdd) {
    const cat = SOURCE_CATEGORY[source];
    const label = SOURCE_LABEL[source];
    for (const batch of chunk(addrs, MAX_BATCH)) {
      console.log(`  + ${batch.length} addr  ${label} (cat ${cat})`);
      if (!dryRun) {
        const tx = await registry.batchAddSanctioned(batch, cat, label);
        const r = await tx.wait();
        if (r) totalGas += r.gasUsed;
      }
    }
  }

  for (const [source, addrs] of diff.toUpdate) {
    const cat = SOURCE_CATEGORY[source];
    const label = SOURCE_LABEL[source];
    for (const batch of chunk(addrs, MAX_BATCH)) {
      console.log(`  ~ ${batch.length} addr  → ${label} (cat ${cat})`);
      if (!dryRun) {
        const tx = await registry.batchAddSanctioned(batch, cat, label);
        const r = await tx.wait();
        if (r) totalGas += r.gasUsed;
      }
    }
  }

  for (const batch of chunk(diff.toRemove, MAX_BATCH)) {
    console.log(`  - ${batch.length} addr  remove`);
    if (!dryRun) {
      const tx = await registry.batchRemoveSanctioned(batch);
      const r = await tx.wait();
      if (r) totalGas += r.gasUsed;
    }
  }

  return totalGas;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const registryAddr = process.env.SANCTIONS_REGISTRY_ADDRESS;
  if (!registryAddr) throw new Error("Set SANCTIONS_REGISTRY_ADDRESS in env.");

  const apply_ = process.env.APPLY === "1";
  const [signer] = await hre.ethers.getSigners();

  const snapshotPath = resolveSnapshotPath();
  const snapshot = loadSnapshot(snapshotPath);

  console.log(`network        : ${hre.network.name}`);
  console.log(`registry       : ${registryAddr}`);
  console.log(`signer         : ${signer.address}`);
  console.log(`mode           : ${apply_ ? "APPLY" : "DRY-RUN"}`);
  console.log(`snapshot       : ${snapshotPath}`);
  console.log(`  fetchedAt    : ${snapshot.fetchedAt}`);
  console.log(`  sources      : ${snapshot.enabledSources.join(", ")}`);
  console.log(`  entries      : ${snapshot.entries.length}`);
  console.log("");

  const registry = (await hre.ethers.getContractAt("IDRPSanctionsRegistry", registryAddr)) as unknown as IDRPSanctionsRegistry;

  console.log("→ reconstructing on-chain state from events...");
  const onChain = await readOnChainEntries(registry);
  console.log(`  on-chain: ${onChain.size}`);

  console.log("→ computing diff...");
  const diff = computeDiff(snapshot.entries, onChain);
  const totalAdd = [...diff.toAdd.values()].reduce((n, arr) => n + arr.length, 0);
  const totalUpdate = [...diff.toUpdate.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(`  toAdd: ${totalAdd}  toUpdate: ${totalUpdate}  toRemove: ${diff.toRemove.length}`);

  console.log("");
  console.log(apply_ ? "→ applying..." : "→ dry-run (set APPLY=1 to send txs)");
  const totalGas = await apply(registry, diff, !apply_);

  console.log("");
  console.log(`done. total gas used: ${totalGas.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

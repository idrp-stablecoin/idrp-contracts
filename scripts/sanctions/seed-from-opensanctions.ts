/**
 * Seed (or sync) IDRPSanctionsRegistry from OpenSanctions.
 *
 * SCOPE — sandbox milestone, per WhatsApp 2026-05-01:
 *   This is a SKELETON / MANUAL-RUN tool, not a long-lived daemon.
 *   It exists to:
 *     (a) prove the diff-only data flow end-to-end against a real on-chain registry,
 *     (b) bootstrap the initial blacklist when the contract is deployed,
 *     (c) serve as the reference implementation when we later promote it to a
 *         proper aggregator service.
 *
 * USAGE:
 *   # Set required env:
 *   #   SANCTIONS_REGISTRY_ADDRESS = 0x...
 *   #   OPENSANCTIONS_API_KEY      = <token>     (optional for dev, required at scale)
 *   #
 *   # Dry-run (default — fetches & diffs but does NOT submit):
 *   npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network kairos
 *   #
 *   # Apply diffs (sends txs):
 *   APPLY=1 npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network kairos
 *
 * DATA POLICY:
 *   - OFAC is DISABLED by default — Indonesia non-aligned posture (lead 2026-05-01).
 *   - Source-to-category mapping codified in `SOURCE_CATEGORY` below.
 *   - To toggle a source on/off, edit `ENABLED_SOURCES`.
 *
 * DIFF RULE (critical):
 *   Re-pushing the entire desired state every cycle wastes ~50k gas/entry.
 *   This script computes only:
 *     toAdd     — addresses in source feed, not yet on-chain
 *     toRemove  — addresses on-chain, no longer in source feed
 *     toUpdate  — addresses present in both but with mismatched category
 *   and submits only those, chunked by MAX_BATCH_SIZE (500).
 *
 * IMPLEMENTATION STATUS:
 *   The OpenSanctions fetch is left as TODO with a clear interface — when
 *   we have an API token and decide which dataset endpoints to hit, fill
 *   in `fetchOpenSanctions()`. Everything below the fetch is functional.
 */

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

const ENABLED_SOURCES: Record<SourceKey, boolean> = {
  il_nbctf: true,
  uk_hmt: true,
  jp_mof: true,
  fr_freezing: true,
  fbi_lazarus: true,
  ransomwhere: true,
  stablecoin_chain_blacklist: true,
  us_ofac_sdn: false, // disabled by default — Indonesia non-aligned posture
};

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

// ─── Data fetch — TODO ────────────────────────────────────────────────────────

/**
 * Pull the active address set from OpenSanctions for the enabled Role-B sources.
 *
 * INTENT (when this gets implemented):
 *   - Hit `https://api.opensanctions.org/search/default?schema=CryptoWallet&...`
 *     with one query per enabled source, paginating via `next_url`.
 *   - For each entity, extract `properties.address[0]` (the wallet hex).
 *   - Filter to EVM addresses (40 hex chars after 0x); drop Tron (base58) until
 *     we deploy on Tron.
 *   - Checksum-normalize every address via `ethers.getAddress(...)`.
 *   - Return one entry per (address, source) tuple. If an address appears in
 *     multiple sources, we keep the first match by the order in ENABLED_SOURCES.
 *
 * Until the API token + dataset choices are confirmed with the lead, this
 * function returns an empty array, which makes the rest of the pipeline
 * trivially correct — it just produces a "no diff" report.
 */
async function fetchOpenSanctions(): Promise<SourceEntry[]> {
  // TODO(adam): wire up fetch when OPENSANCTIONS_API_KEY is provisioned.
  console.warn("⚠️  fetchOpenSanctions() not yet implemented — returning empty set.");
  return [];
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

  console.log(`network        : ${hre.network.name}`);
  console.log(`registry       : ${registryAddr}`);
  console.log(`signer         : ${signer.address}`);
  console.log(`mode           : ${apply_ ? "APPLY" : "DRY-RUN"}`);
  console.log(`enabled sources: ${Object.entries(ENABLED_SOURCES).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
  console.log("");

  const registry = (await hre.ethers.getContractAt("IDRPSanctionsRegistry", registryAddr)) as unknown as IDRPSanctionsRegistry;

  console.log("→ fetching desired state from OpenSanctions...");
  const desiredAll = await fetchOpenSanctions();
  const desired = desiredAll.filter((e) => ENABLED_SOURCES[e.source]);
  console.log(`  fetched: ${desiredAll.length}  enabled-after-filter: ${desired.length}`);

  console.log("→ reconstructing on-chain state from events...");
  const onChain = await readOnChainEntries(registry);
  console.log(`  on-chain: ${onChain.size}`);

  console.log("→ computing diff...");
  const diff = computeDiff(desired, onChain);
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

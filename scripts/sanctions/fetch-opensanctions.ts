/**
 * Fetch sanctioned wallet addresses from OpenSanctions and write a snapshot
 * JSON file to scripts/sanctions/results/<UTC-timestamp>.json.
 *
 * NEVER touches the chain. The output JSON is the input to seed-from-opensanctions.ts.
 *
 * Usage:
 *   npx hardhat run scripts/sanctions/fetch-opensanctions.ts
 *
 * Env:
 *   OPENSANCTIONS_API_KEY  — required for paginated/full-volume access (optional in dev)
 *   FETCH_OUTPUT_DIR       — override the default scripts/sanctions/results directory
 *   OPENSANCTIONS_FIXTURE  — set to "1" for a small fixture set (no API key needed)
 *
 * Output snapshot shape (one file per run):
 *   {
 *     "fetchedAt":      "2026-05-02T08:00:00.000Z",
 *     "enabledSources": ["il_nbctf","uk_hmt", ...],
 *     "stats":          { "il_nbctf": 1639, "uk_hmt": 20, ... },
 *     "addresses":      ["0x1111...", "0x2222...", ...]  // checksummed, deduped
 *   }
 *
 * Source policy: OFAC disabled by default (Indonesia non-aligned posture).
 * The downstream `addToSanctionsList(address[])` call has no per-entry
 * metadata — we just push a flat address array. The `enabledSources` and
 * `stats` fields exist purely for the audit trail of what feed produced it.
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";

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

interface SourcedAddress {
  address: string; // checksummed EVM address
  source: SourceKey; // first source that contributed this address
}

interface Snapshot {
  fetchedAt: string;
  enabledSources: SourceKey[];
  stats: Record<string, number>;
  addresses: string[]; // flat checksummed list — what the on-chain call consumes
}

// ─── OpenSanctions fetch — TODO when API key is provisioned ───────────────────

/**
 * Returns one entry per (address, source) before dedup. The caller dedupes
 * and records per-source contribution stats from this list.
 */
async function fetchFromOpenSanctions(enabled: SourceKey[]): Promise<SourcedAddress[]> {
  const apiKey = process.env.OPENSANCTIONS_API_KEY;
  if (!apiKey) {
    console.warn("⚠️  OPENSANCTIONS_API_KEY not set — using empty/fixture set.");
    console.warn("   Provide a key (or fill in fetchFromOpenSanctions) before production use.");

    if (process.env.OPENSANCTIONS_FIXTURE === "1") {
      const samples: SourcedAddress[] = [
        { address: hre.ethers.getAddress("0x" + "1".repeat(40)), source: "il_nbctf" },
        { address: hre.ethers.getAddress("0x" + "2".repeat(40)), source: "uk_hmt" },
        { address: hre.ethers.getAddress("0x" + "3".repeat(40)), source: "ransomwhere" },
      ];
      return samples.filter((e) => enabled.includes(e.source));
    }
    return [];
  }

  // TODO(adam): paginated OpenSanctions fetch. Suggested shape:
  //
  //   const results: SourcedAddress[] = [];
  //   for (const source of enabled) {
  //     const datasetSlug = OPEN_SANCTIONS_DATASET_SLUG[source];
  //     let url = `https://api.opensanctions.org/search/${datasetSlug}?schema=CryptoWallet&limit=200`;
  //     while (url) {
  //       const r = await fetch(url, { headers: { Authorization: `ApiKey ${apiKey}` } });
  //       const body = await r.json();
  //       for (const item of body.results) {
  //         const raw = item.properties?.address?.[0];
  //         if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw)) {
  //           results.push({ address: hre.ethers.getAddress(raw), source });
  //         }
  //       }
  //       url = body.next_url;
  //     }
  //   }
  //   return results;
  throw new Error("OpenSanctions fetch not yet implemented — fill in fetchFromOpenSanctions().");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const enabled = (Object.keys(ENABLED_SOURCES) as SourceKey[]).filter((k) => ENABLED_SOURCES[k]);
  console.log(`enabled sources: ${enabled.join(", ")}`);

  const all = await fetchFromOpenSanctions(enabled);

  // De-dupe by address; keep the first source for the stats column.
  const seen = new Set<string>();
  const stats: Record<string, number> = {};
  const addresses: string[] = [];
  for (const e of all) {
    if (seen.has(e.address)) continue;
    seen.add(e.address);
    addresses.push(e.address);
    stats[e.source] = (stats[e.source] ?? 0) + 1;
  }

  const snapshot: Snapshot = {
    fetchedAt: new Date().toISOString(),
    enabledSources: enabled,
    stats,
    addresses,
  };

  const outDir =
    process.env.FETCH_OUTPUT_DIR ??
    path.join(hre.config.paths.root || process.cwd(), "scripts/sanctions/results");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const tsSafe = snapshot.fetchedAt.replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${tsSafe}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`fetched ${addresses.length} unique addresses across ${Object.keys(stats).length} sources`);
  for (const [src, n] of Object.entries(stats)) console.log(`  ${src.padEnd(28)} ${n}`);
  console.log("");
  console.log(`✓ snapshot written to ${outPath}`);
  console.log(`  next: SANCTIONS_LIST_ADDRESS=0x... \\`);
  console.log(`        SANCTIONS_SNAPSHOT_PATH=${outPath} \\`);
  console.log(`        APPLY=1 npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network <chain>`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

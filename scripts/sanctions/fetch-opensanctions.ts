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
 *
 * Output snapshot shape (one file per run):
 *   {
 *     "fetchedAt":      "2026-05-01T12:34:56.000Z",
 *     "enabledSources": ["il_nbctf","uk_hmt", ...],
 *     "stats":          { "il_nbctf": 1639, "uk_hmt": 20, ... },
 *     "entries":        [{ "address": "0x...", "source": "il_nbctf" }, ...]
 *   }
 *
 * Source policy: same as seed-from-opensanctions.ts. OFAC disabled by default
 * (Indonesia non-aligned posture). To toggle, edit ENABLED_SOURCES.
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";

// ─── Source policy (mirror of seed-from-opensanctions.ts) ────────────────────

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

interface SourceEntry {
  address: string; // checksummed EVM address
  source: SourceKey;
}

interface Snapshot {
  fetchedAt: string;
  enabledSources: SourceKey[];
  stats: Record<string, number>;
  entries: SourceEntry[];
}

// ─── OpenSanctions fetch — TODO when API key is provisioned ───────────────────

/**
 * INTENT (when this gets implemented):
 *   - Hit `https://api.opensanctions.org/search/default?schema=CryptoWallet&...`
 *     with one query per enabled source dataset, paginating via `next_url`.
 *   - For each entity, extract `properties.address[0]` (the wallet hex).
 *   - Filter to EVM addresses (40 hex chars after 0x); drop Tron base58 until we
 *     deploy on Tron.
 *   - Checksum-normalize via `ethers.getAddress(...)`.
 *   - Return one entry per (address, source) tuple. If an address appears in
 *     multiple sources, keep the first match by order of ENABLED_SOURCES.
 *
 * Until OPENSANCTIONS_API_KEY is provisioned, this returns a small fixture set
 * (with the OPENSANCTIONS_FIXTURE env var) or an empty array.
 */
async function fetchFromOpenSanctions(enabled: SourceKey[]): Promise<SourceEntry[]> {
  const apiKey = process.env.OPENSANCTIONS_API_KEY;
  if (!apiKey) {
    console.warn("⚠️  OPENSANCTIONS_API_KEY not set — using empty fixture set.");
    console.warn("   Provide a key (or fill in fetchFromOpenSanctions) before production use.");

    // Optional fixture mode for local end-to-end testing of the snapshot/diff/apply pipeline.
    if (process.env.OPENSANCTIONS_FIXTURE === "1") {
      const samples: SourceEntry[] = [
        { address: hre.ethers.getAddress("0x" + "1".repeat(40)), source: "il_nbctf" },
        { address: hre.ethers.getAddress("0x" + "2".repeat(40)), source: "uk_hmt" },
        { address: hre.ethers.getAddress("0x" + "3".repeat(40)), source: "ransomwhere" },
      ];
      return samples.filter((e) => enabled.includes(e.source));
    }
    return [];
  }

  // TODO(adam): implement the paginated OpenSanctions fetch here once the API
  // key is provisioned. Suggested shape:
  //
  //   const results: SourceEntry[] = [];
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

  // De-dupe by address — keep the first (most-trusted) source per address.
  const seen = new Set<string>();
  const entries: SourceEntry[] = [];
  for (const e of all) {
    if (seen.has(e.address)) continue;
    seen.add(e.address);
    entries.push(e);
  }

  // Build per-source stats so the snapshot shows volume contribution at a glance.
  const stats: Record<string, number> = {};
  for (const e of entries) stats[e.source] = (stats[e.source] ?? 0) + 1;

  const snapshot: Snapshot = {
    fetchedAt: new Date().toISOString(),
    enabledSources: enabled,
    stats,
    entries,
  };

  const outDir =
    process.env.FETCH_OUTPUT_DIR ??
    path.join(hre.config.paths.root || process.cwd(), "scripts/sanctions/results");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // ISO timestamp with `:` swapped for `-` so the filename is filesystem-safe on Windows.
  const tsSafe = snapshot.fetchedAt.replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${tsSafe}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`fetched ${entries.length} unique addresses across ${Object.keys(stats).length} sources`);
  for (const [src, n] of Object.entries(stats)) console.log(`  ${src.padEnd(28)} ${n}`);
  console.log("");
  console.log(`✓ snapshot written to ${outPath}`);
  console.log(`  next: SANCTIONS_REGISTRY_ADDRESS=0x... \\`);
  console.log(`        SANCTIONS_SNAPSHOT_PATH=${outPath} \\`);
  console.log(`        APPLY=1 npx hardhat run scripts/sanctions/seed-from-opensanctions.ts --network <chain>`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

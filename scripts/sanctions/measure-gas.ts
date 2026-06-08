/**
 * Measure SanctionsList gas on a real network.
 *
 * Usage:
 *   npx hardhat run scripts/sanctions/measure-gas.ts --network kairos
 *
 * Behavior:
 *   - Deploys a fresh SanctionsList (deployer becomes owner).
 *   - Runs a representative subset of the gas-test scenarios with REAL receipts
 *     (any chain-specific data-availability or opcode pricing is included).
 *   - Prints a paste-ready markdown table with chain-specific cost columns.
 *
 * Total gas burn ≈ 30M which is well below typical testnet faucet drips.
 */

import hre from "hardhat";
import type { ContractTransactionResponse } from "ethers";

interface Row {
  scenario: string;
  entries: number | "—";
  gasUsed: bigint;
}

function makeAddrs(start: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(hre.ethers.getAddress("0x" + (start + i).toString(16).padStart(40, "0")));
  }
  return out;
}

async function gasOf(tx: ContractTransactionResponse): Promise<bigint> {
  const r = await tx.wait();
  if (!r) throw new Error("no receipt");
  return r.gasUsed;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = hre.network.config.chainId ?? 0;
  const gasPriceConfigured = hre.network.config.gasPrice;
  const gasPriceGwei =
    gasPriceConfigured && gasPriceConfigured !== "auto"
      ? Number(gasPriceConfigured) / 1e9
      : Number((await hre.ethers.provider.getFeeData()).gasPrice ?? 0n) / 1e9;

  console.log(`network         : ${networkName} (chainId ${chainId})`);
  console.log(`deployer        : ${deployer.address}`);
  console.log(`gas price (gwei): ${gasPriceGwei}`);
  console.log("");

  // ── Deploy ──────────────────────────────────────────────────────────────
  const Factory = await hre.ethers.getContractFactory("SanctionsList");
  const list = await Factory.deploy();
  await list.waitForDeployment();
  const deployTx = list.deploymentTransaction();
  if (!deployTx) throw new Error("no deployment transaction");
  const deployReceipt = await deployTx.wait();
  if (!deployReceipt) throw new Error("no deployment receipt");

  const results: Row[] = [];
  results.push({ scenario: "Deployment", entries: "—", gasUsed: deployReceipt.gasUsed });
  console.log(`✓ deployed at ${await list.getAddress()} (gas ${deployReceipt.gasUsed.toString()})`);

  // ── Add 1 ───────────────────────────────────────────────────────────────
  let g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_0001, 1)));
  results.push({ scenario: "Add 1 fresh", entries: 1, gasUsed: g });
  console.log(`✓ add 1 fresh: ${g.toString()} gas`);

  // ── Add 10 ──────────────────────────────────────────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_0010, 10)));
  results.push({ scenario: "Add 10 fresh", entries: 10, gasUsed: g });
  console.log(`✓ add 10 fresh: ${g.toString()} gas`);

  // ── Add 100 ─────────────────────────────────────────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_0100, 100)));
  results.push({ scenario: "Add 100 fresh", entries: 100, gasUsed: g });
  console.log(`✓ add 100 fresh: ${g.toString()} gas`);

  // ── Add 200 ─────────────────────────────────────────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_0200, 200)));
  results.push({ scenario: "Add 200 fresh", entries: 200, gasUsed: g });
  console.log(`✓ add 200 fresh: ${g.toString()} gas`);

  // ── Add 220 (lead's specific question) ──────────────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_0400, 220)));
  results.push({ scenario: "Add 220 fresh", entries: 220, gasUsed: g });
  console.log(`✓ add 220 fresh: ${g.toString()} gas`);

  // ── Add 500 (round 1) ───────────────────────────────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_1000, 500)));
  results.push({ scenario: "Add 500 fresh (round 1)", entries: 500, gasUsed: g });
  console.log(`✓ add 500 fresh (round 1): ${g.toString()} gas`);

  // ── Add 500 (round 2) — proves O(1) per-entry ───────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_2000, 500)));
  results.push({ scenario: "Add 500 fresh (round 2)", entries: 500, gasUsed: g });
  console.log(`✓ add 500 fresh (round 2): ${g.toString()} gas`);

  // ── Re-add 100 (no-op fast lane) ────────────────────────────────────────
  g = await gasOf(await list.addToSanctionsList(makeAddrs(0x10_0100, 100)));
  results.push({ scenario: "Re-add 100 (no-op)", entries: 100, gasUsed: g });
  console.log(`✓ re-add 100 (no-op): ${g.toString()} gas`);

  // ── Remove 100 ──────────────────────────────────────────────────────────
  g = await gasOf(await list.removeFromSanctionsList(makeAddrs(0x10_0100, 100)));
  results.push({ scenario: "Remove 100 (batch)", entries: 100, gasUsed: g });
  console.log(`✓ remove 100: ${g.toString()} gas`);

  // ── Realistic keeper sync (5 add + 2 remove) ────────────────────────────
  const addG = await gasOf(await list.addToSanctionsList(makeAddrs(0x90_0000, 5)));
  const removeG = await gasOf(await list.removeFromSanctionsList(makeAddrs(0x10_0010, 2)));
  results.push({ scenario: "Keeper sync (5 add + 2 remove)", entries: 7, gasUsed: addG + removeG });
  console.log(`✓ keeper sync: ${(addG + removeG).toString()} gas`);

  // ── Print markdown table ────────────────────────────────────────────────
  const nativeUsd: Record<string, number> = {
    kairos: 0.15,
    kaia: 0.15,
    polygon: 0.4,
    bsc: 650,
    sepolia: 2310,
    holesky: 2310,
    mainnet: 2310,
    baseSepolia: 2310, // ETH (testnet — real cost is zero, USD shown for prod parity)
    base: 2310,
  };
  const nativeSymbol: Record<string, string> = {
    kairos: "KAIA",
    kaia: "KAIA",
    polygon: "MATIC",
    bsc: "BNB",
    sepolia: "ETH",
    holesky: "ETH",
    mainnet: "ETH",
    baseSepolia: "ETH",
    base: "ETH",
  };

  const usd = nativeUsd[networkName] ?? 0;
  const sym = nativeSymbol[networkName] ?? "native";

  console.log("");
  console.log(`# SanctionsList — measured gas on ${networkName}`);
  console.log("");
  console.log(`> Captured: ${new Date().toISOString()}`);
  console.log(`> Gas price: ${gasPriceGwei} gwei · Native price assumed: $${usd}/${sym}`);
  console.log("");
  console.log(`| # | Scenario | Entries | Gas | Gas/entry | ${sym} | USD |`);
  console.log(`|---:|---|---:|---:|---:|---:|---:|`);
  results.forEach((r, i) => {
    const perEntry =
      typeof r.entries === "number" && r.entries > 0
        ? Math.round(Number(r.gasUsed) / r.entries).toLocaleString()
        : "—";
    const native = (Number(r.gasUsed) * gasPriceGwei) / 1e9;
    const dollars = native * usd;
    console.log(
      `| ${i + 1} | ${r.scenario} | ${r.entries} | ${r.gasUsed.toLocaleString()} | ${perEntry} | ${native.toFixed(4)} | $${dollars.toFixed(4)} |`
    );
  });
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

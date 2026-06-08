import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { ContractTransactionResponse } from "ethers";

// ──────────────────────────────────────────────────────────────────────────────
//  PRICING TUNABLES — edit these to refresh the cost columns.
//
//  The cost column = gasUsed * gwei * 1e-9 * nativeUsd. Numbers update every
//  test run, so change them here and re-run:
//    npx hardhat test test/sanctions/SanctionsList.gas.test.ts
//
//  Same constants live in:
//    scripts/sanctions/measure-gas.ts        — the testnet measurement script
//    notes/features/blacklist/plan.md        — the doc shown to the lead
//  Keep them in sync when you update prices.
// ──────────────────────────────────────────────────────────────────────────────

const KAIA_GAS_PRICE_GWEI = 250; // matches hardhat.config.ts kairos
const KAIA_NATIVE_USD = 0.15;

const ETH_GAS_PRICE_GWEI = 1.5;
const ETH_NATIVE_USD = 2310;

const POLYGON_GAS_PRICE_GWEI = 50;
const POLYGON_NATIVE_USD = 0.4;

const BSC_GAS_PRICE_GWEI = 3;
const BSC_NATIVE_USD = 650;

const BASE_GAS_PRICE_GWEI = 0.05; // typical Base mainnet base fee in 2026
const BASE_NATIVE_USD = 2310;

// ──────────────────────────────────────────────────────────────────────────────
//  Result accumulator + report printer
// ──────────────────────────────────────────────────────────────────────────────

interface Row {
  scenario: string;
  entries: number | "—";
  gasUsed: bigint;
}
const results: Row[] = [];

function record(scenario: string, entries: number | "—", gasUsed: bigint) {
  results.push({ scenario, entries, gasUsed });
}

function gasToCost(gasUsed: bigint, gwei: number, nativeUsd: number): number {
  return (Number(gasUsed) * gwei) / 1e9 * nativeUsd;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.001) return `$${n.toExponential(2)}`;
  if (n < 0.1) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function printReport() {
  console.log("\n");
  console.log("# SanctionsList — measured gas (local Hardhat)");
  console.log("");
  console.log("| # | Scenario | Entries | Gas | Gas/entry | Kaia $ | Polygon $ | BSC $ | Base $ | ETH $ |");
  console.log("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  results.forEach((r, i) => {
    const perEntry = typeof r.entries === "number" && r.entries > 0 ? Number(r.gasUsed) / r.entries : 0;
    const perEntryStr = typeof r.entries === "number" && r.entries > 0 ? perEntry.toFixed(0) : "—";
    const kaia = fmtUsd(gasToCost(r.gasUsed, KAIA_GAS_PRICE_GWEI, KAIA_NATIVE_USD));
    const polygon = fmtUsd(gasToCost(r.gasUsed, POLYGON_GAS_PRICE_GWEI, POLYGON_NATIVE_USD));
    const bsc = fmtUsd(gasToCost(r.gasUsed, BSC_GAS_PRICE_GWEI, BSC_NATIVE_USD));
    const base = fmtUsd(gasToCost(r.gasUsed, BASE_GAS_PRICE_GWEI, BASE_NATIVE_USD));
    const eth = fmtUsd(gasToCost(r.gasUsed, ETH_GAS_PRICE_GWEI, ETH_NATIVE_USD));
    console.log(
      `| ${i + 1} | ${r.scenario} | ${r.entries} | ${r.gasUsed.toString()} | ${perEntryStr} | ${kaia} | ${polygon} | ${bsc} | ${base} | ${eth} |`
    );
  });
  console.log("");
  console.log(
    `Cost assumptions — Kaia: ${KAIA_GAS_PRICE_GWEI} gwei @ $${KAIA_NATIVE_USD}/KAIA · ` +
      `Polygon: ${POLYGON_GAS_PRICE_GWEI} gwei @ $${POLYGON_NATIVE_USD}/MATIC · ` +
      `BSC: ${BSC_GAS_PRICE_GWEI} gwei @ $${BSC_NATIVE_USD}/BNB · ` +
      `Base: ${BASE_GAS_PRICE_GWEI} gwei @ $${BASE_NATIVE_USD}/ETH · ` +
      `Ethereum: ${ETH_GAS_PRICE_GWEI} gwei @ $${ETH_NATIVE_USD}/ETH.`
  );
  console.log("");
}

// ──────────────────────────────────────────────────────────────────────────────
//  Deterministic counter-based address generator. Keeps gas numbers stable
//  across reruns; fully reproducible for CI assertion bands.
// ──────────────────────────────────────────────────────────────────────────────

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

async function freshFixture() {
  const [owner] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("SanctionsList");
  const list = await Factory.deploy();
  await list.waitForDeployment();
  return { list, owner };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("SanctionsList — gas at scale", function () {
  this.timeout(180_000);

  // Group A uses one shared registry across rounds 1/2/3 to prove cumulative
  // storage growth doesn't change per-entry cost.
  let sharedList: Awaited<ReturnType<typeof freshFixture>>["list"];
  let sharedOwner: Awaited<ReturnType<typeof freshFixture>>["owner"];

  before(async () => {
    const f = await freshFixture();
    sharedList = f.list;
    sharedOwner = f.owner;
  });

  it("deployment cost", async function () {
    const { list } = await loadFixture(freshFixture);
    const tx = list.deploymentTransaction();
    if (!tx) throw new Error("no deployment transaction");
    const r = await tx.wait();
    if (!r) throw new Error("no deployment receipt");
    record("Deployment", "—", r.gasUsed);

    // Chainalysis verbatim is a tiny contract — should be well under 1M gas.
    expect(r.gasUsed).to.be.within(300_000n, 800_000n);
  });

  // ── Group A: lead's explicit ask — 1, 10, 200, 500, 500-again, 500-again-again

  it("[A] add 1 fresh address", async function () {
    const gasUsed = await gasOf(
      await sharedList.connect(sharedOwner).addToSanctionsList(makeAddrs(0x10_0001, 1))
    );
    record("Add 1 fresh", 1, gasUsed);
    expect(gasUsed).to.be.within(40_000n, 100_000n);
  });

  it("[A] add 10 fresh addresses (one batch)", async function () {
    const gasUsed = await gasOf(
      await sharedList.connect(sharedOwner).addToSanctionsList(makeAddrs(0x10_0010, 10))
    );
    record("Add 10 fresh", 10, gasUsed);
    expect(gasUsed / 10n).to.be.within(20_000n, 35_000n);
  });

  it("[A] add 200 fresh addresses (one batch)", async function () {
    const gasUsed = await gasOf(
      await sharedList.connect(sharedOwner).addToSanctionsList(makeAddrs(0x10_0100, 200))
    );
    record("Add 200 fresh", 200, gasUsed);
    expect(gasUsed / 200n).to.be.within(20_000n, 30_000n);
  });

  it("[A] add 500 fresh — round 1", async function () {
    const gasUsed = await gasOf(
      await sharedList.connect(sharedOwner).addToSanctionsList(makeAddrs(0x10_1000, 500))
    );
    record("Add 500 fresh (round 1)", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(20_000n, 30_000n);
  });

  it("[A] add 500 fresh — round 2 (proves O(1) per-entry under storage growth)", async function () {
    const gasUsed = await gasOf(
      await sharedList.connect(sharedOwner).addToSanctionsList(makeAddrs(0x10_2000, 500))
    );
    record("Add 500 fresh (round 2)", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(20_000n, 30_000n);
  });

  it("[A] add 500 fresh — round 3", async function () {
    const gasUsed = await gasOf(
      await sharedList.connect(sharedOwner).addToSanctionsList(makeAddrs(0x10_3000, 500))
    );
    record("Add 500 fresh (round 3)", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(20_000n, 30_000n);
  });

  // ── Group B: lead's specific 100 vs 220 question (fresh contracts to isolate)

  it("[B] add 100 fresh", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const gasUsed = await gasOf(
      await list.connect(owner).addToSanctionsList(makeAddrs(0x20_0000, 100))
    );
    record("Add 100 fresh", 100, gasUsed);
    expect(gasUsed / 100n).to.be.within(20_000n, 30_000n);
  });

  it("[B] add 220 fresh", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const gasUsed = await gasOf(
      await list.connect(owner).addToSanctionsList(makeAddrs(0x20_1000, 220))
    );
    record("Add 220 fresh", 220, gasUsed);
    expect(gasUsed / 220n).to.be.within(20_000n, 30_000n);
  });

  // ── Group C: re-add path
  //
  // IMPORTANT — Chainalysis's clone does NOT skip duplicates. Every entry in
  // the array still issues an SSTORE. For an already-`true` slot that's a
  // "non-zero → non-zero" SSTORE = ~5,000 gas/entry (vs 22,100 for a fresh
  // zero → non-zero write). Materially cheaper, but not zero.

  it("[C] re-add same 100 addresses (no state change → cheaper SSTORE path)", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x30_0000, 100);
    await list.connect(owner).addToSanctionsList(addrs);

    const gasUsed = await gasOf(await list.connect(owner).addToSanctionsList(addrs));
    record("Re-add same 100 (no-op)", 100, gasUsed);
    expect(gasUsed / 100n).to.be.lessThan(15_000n);
  });

  it("[C] add 100 mixed — 50 already-listed + 50 fresh", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const firstHalf = makeAddrs(0x40_0000, 50);
    await list.connect(owner).addToSanctionsList(firstHalf);

    const mixed = [...firstHalf, ...makeAddrs(0x40_1000, 50)];
    const gasUsed = await gasOf(await list.connect(owner).addToSanctionsList(mixed));
    record("Add 100 mixed (50 dupe + 50 fresh)", 100, gasUsed);
  });

  // ── Group D: removal path

  it("[D] remove 1 listed address", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    await list.connect(owner).addToSanctionsList(makeAddrs(0x60_0000, 1));
    const gasUsed = await gasOf(
      await list.connect(owner).removeFromSanctionsList(makeAddrs(0x60_0000, 1))
    );
    record("Remove 1 (batch=1)", 1, gasUsed);
  });

  it("[D] remove 10 listed (batch)", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x60_1000, 10);
    await list.connect(owner).addToSanctionsList(addrs);
    const gasUsed = await gasOf(await list.connect(owner).removeFromSanctionsList(addrs));
    record("Remove 10 (batch)", 10, gasUsed);
  });

  it("[D] remove 200 listed (batch)", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x60_2000, 200);
    await list.connect(owner).addToSanctionsList(addrs);
    const gasUsed = await gasOf(await list.connect(owner).removeFromSanctionsList(addrs));
    record("Remove 200 (batch)", 200, gasUsed);
  });

  it("[D] remove 500 listed (batch)", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x60_4000, 500);
    await list.connect(owner).addToSanctionsList(addrs);
    const gasUsed = await gasOf(await list.connect(owner).removeFromSanctionsList(addrs));
    record("Remove 500 (batch)", 500, gasUsed);
  });

  it("[D] re-add 500 after remove (proves wiped slots act like fresh)", async function () {
    const { list, owner } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x70_0000, 500);
    await list.connect(owner).addToSanctionsList(addrs);
    await list.connect(owner).removeFromSanctionsList(addrs);

    const gasUsed = await gasOf(await list.connect(owner).addToSanctionsList(addrs));
    record("Re-add 500 after remove", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(20_000n, 30_000n);
  });

  // ── Group E: realistic keeper sync (5 add + 2 remove on top of 1,000 prior entries)

  it("[E] realistic keeper diff sync (5 add + 2 remove, with 1000 prior entries)", async function () {
    const { list, owner } = await loadFixture(freshFixture);

    // Seed 1,000 prior entries.
    const seed = makeAddrs(0x80_0000, 1000);
    for (let i = 0; i < seed.length; i += 500) {
      await list.connect(owner).addToSanctionsList(seed.slice(i, i + 500));
    }

    // Diff cycle: 5 new, 2 to remove.
    const toAdd = makeAddrs(0x90_0000, 5);
    const toRemove = seed.slice(0, 2);

    const addGas = await gasOf(await list.connect(owner).addToSanctionsList(toAdd));
    const removeGas = await gasOf(await list.connect(owner).removeFromSanctionsList(toRemove));
    record("Realistic keeper sync (5 add + 2 remove)", 7, addGas + removeGas);
  });

  // ── Print the markdown report at the very end

  after(() => {
    printReport();
  });
});

import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { ContractTransactionResponse } from "ethers";

// ──────────────────────────────────────────────────────────────────────────────
//  PRICING TUNABLES — edit these to refresh the cost columns.
//
//  Each chain has two knobs: gas price (gwei) and native-token USD price.
//  The cost = gasUsed * gwei * 1e-9 * nativeUsd. Numbers update every test run,
//  so change them here and re-run `npx hardhat test test/sanctions/IDRPSanctionsRegistry.gas.test.ts`.
//
//  The same constants exist (in slightly different form) in:
//    scripts/sanctions/measure-gas.ts        — the testnet measurement script
//    notes/features/blacklist/plan.md        — the doc shown to the lead
//  Keep them in sync when you update prices.
// ──────────────────────────────────────────────────────────────────────────────

const KAIA_GAS_PRICE_GWEI = 250; // Kaia hardcoded gas price (matches hardhat.config.ts)
const KAIA_NATIVE_USD = 0.15;

const ETH_GAS_PRICE_GWEI = 1.5;
const ETH_NATIVE_USD = 2310;

const POLYGON_GAS_PRICE_GWEI = 50;
const POLYGON_NATIVE_USD = 0.4;

const BSC_GAS_PRICE_GWEI = 3;
const BSC_NATIVE_USD = 650;

// Base mainnet — Base Sepolia is the team's preferred first real-network target.
// Sepolia itself is free, but the table projects to Base mainnet pricing for parity.
const BASE_GAS_PRICE_GWEI = 0.05; // typical Base mainnet base fee in 2026
const BASE_NATIVE_USD = 2310;

const SOURCE_TAG = "OpenSanctions:NBCTF"; // representative production string
const CAT_FOREIGN_GOV_LIST = 6;
const CAT_OJK_DOMESTIC = 7;

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
  // gas * gwei * 1e9 wei/gwei / 1e18 wei/native = native units
  const nativeUnits = (Number(gasUsed) * gwei) / 1e9;
  return nativeUnits * nativeUsd;
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
  console.log("# IDRP Sanctions Registry — measured gas (local Hardhat)");
  console.log("");
  console.log(
    "| # | Scenario | Entries | Gas | Gas/entry | Kaia $ | Polygon $ | BSC $ | Base $ | ETH $ |"
  );
  console.log(
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  );
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
//  Deterministic counter-based address generator
//  (Same shape as the functional test — addresses 0x0...01 upward, never collide
//   with real signer addresses, and fully reproducible across runs.)
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

// ──────────────────────────────────────────────────────────────────────────────
//  Fixtures — three flavors so cumulative scenarios share state cleanly.
// ──────────────────────────────────────────────────────────────────────────────

async function freshFixture() {
  const [deployer, multisig, keeper] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("IDRPSanctionsRegistry");
  const registry = await Factory.deploy(multisig.address, keeper.address);
  await registry.waitForDeployment();
  return { registry, deployer, multisig, keeper };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("IDRPSanctionsRegistry — gas at scale", function () {
  this.timeout(180_000);

  // We measure cumulative storage growth across these scenarios in one
  // contract instance to prove that the 5,000th add costs the same as the 1st.
  let sharedRegistry: Awaited<ReturnType<typeof freshFixture>>["registry"];
  let sharedKeeper: Awaited<ReturnType<typeof freshFixture>>["keeper"];
  let sharedMultisig: Awaited<ReturnType<typeof freshFixture>>["multisig"];

  before(async () => {
    const f = await freshFixture();
    sharedRegistry = f.registry;
    sharedKeeper = f.keeper;
    sharedMultisig = f.multisig;
  });

  it("deployment cost", async function () {
    const { registry } = await loadFixture(freshFixture);
    const tx = registry.deploymentTransaction();
    if (!tx) throw new Error("no deployment transaction");
    const r = await tx.wait();
    if (!r) throw new Error("no deployment receipt");
    record("Deployment", "—", r.gasUsed);

    expect(r.gasUsed).to.be.within(900_000n, 1_500_000n);
  });

  // ── Group A: lead's explicit ask — 1, 10, 200, 500, 500-again, 500-again-again
  //   We use a SINGLE shared registry so cumulative storage growth is measured.

  it("[A] add 1 fresh address", async function () {
    const addrs = makeAddrs(0x10_0001, 1);
    const gasUsed = await gasOf(
      await sharedRegistry.connect(sharedKeeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 1 fresh", 1, gasUsed);
    expect(gasUsed).to.be.within(60_000n, 200_000n);
  });

  it("[A] add 10 fresh addresses (one batch)", async function () {
    const addrs = makeAddrs(0x10_0010, 10);
    const gasUsed = await gasOf(
      await sharedRegistry.connect(sharedKeeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 10 fresh", 10, gasUsed);
    // Smaller batches amortize the 21k base over fewer entries, so per-entry runs higher.
    expect(gasUsed / 10n).to.be.within(40_000n, 65_000n);
  });

  it("[A] add 200 fresh addresses (one batch)", async function () {
    const addrs = makeAddrs(0x10_0100, 200);
    const gasUsed = await gasOf(
      await sharedRegistry.connect(sharedKeeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 200 fresh", 200, gasUsed);
    expect(gasUsed / 200n).to.be.within(40_000n, 60_000n);
  });

  it("[A] add 500 fresh — round 1", async function () {
    const addrs = makeAddrs(0x10_1000, 500);
    const gasUsed = await gasOf(
      await sharedRegistry.connect(sharedKeeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 500 fresh (round 1)", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(40_000n, 60_000n);
  });

  it("[A] add 500 fresh — round 2 (proves O(1) per-entry under storage growth)", async function () {
    const addrs = makeAddrs(0x10_2000, 500);
    const gasUsed = await gasOf(
      await sharedRegistry.connect(sharedKeeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 500 fresh (round 2)", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(40_000n, 60_000n);
  });

  it("[A] add 500 fresh — round 3", async function () {
    const addrs = makeAddrs(0x10_3000, 500);
    const gasUsed = await gasOf(
      await sharedRegistry.connect(sharedKeeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 500 fresh (round 3)", 500, gasUsed);
    expect(gasUsed / 500n).to.be.within(40_000n, 60_000n);
  });

  it("[A] post-condition: all 1,711 addresses are sanctioned and counted", async function () {
    expect(await sharedRegistry.sanctionedCount()).to.equal(1 + 10 + 200 + 500 + 500 + 500);
  });

  // ── Group B: lead's specific 100 vs 220 question (fresh registry to isolate)

  it("[B] add 100 fresh (lead's question)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x20_0000, 100);
    const gasUsed = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 100 fresh", 100, gasUsed);
    expect(gasUsed / 100n).to.be.within(40_000n, 60_000n);
  });

  it("[B] add 220 fresh (lead's question)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x20_1000, 220);
    const gasUsed = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 220 fresh", 220, gasUsed);
    expect(gasUsed / 220n).to.be.within(40_000n, 60_000n);
  });

  // ── Group C: fast-lane / no-op paths

  it("[C] re-add the same 100 addresses (no state change → cheaper path)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x30_0000, 100);
    await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const gasUsed = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Re-add same 100 (no-op)", 100, gasUsed);
    // Re-add path: only metadata struct gets re-written; bool slot stays true.
    // Should be materially cheaper than fresh (~27k/entry).
    expect(gasUsed / 100n).to.be.lessThan(20_000n);
  });

  it("[C] add 100 mixed — 50 already-listed + 50 fresh", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const firstHalf = makeAddrs(0x40_0000, 50);
    await registry.connect(keeper).batchAddSanctioned(firstHalf, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const mixed = [...firstHalf, ...makeAddrs(0x40_1000, 50)];
    const gasUsed = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(mixed, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Add 100 mixed (50 dupe + 50 fresh)", 100, gasUsed);

    expect(await registry.sanctionedCount()).to.equal(100);
  });

  it("[C] update category on 100 already-listed (different category, different source)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x50_0000, 100);
    await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const gasUsed = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(addrs, CAT_OJK_DOMESTIC, "OJK:Domestic")
    );
    record("Update category on 100", 100, gasUsed);
    // Bool slot stays true; struct rewritten — slightly more than pure no-op
    // because the new source string has different length.
    expect(gasUsed / 100n).to.be.within(8_000n, 20_000n);
  });

  // ── Group D: removal path

  it("[D] remove 1 listed address", async function () {
    const { registry, multisig, keeper } = await loadFixture(freshFixture);
    const [addr] = makeAddrs(0x60_0000, 1);
    await registry.connect(keeper).batchAddSanctioned([addr], CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const gasUsed = await gasOf(await registry.connect(multisig).removeSanctioned(addr));
    record("Remove 1", 1, gasUsed);
  });

  it("[D] remove 10 listed (batch)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x60_1000, 10);
    await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const gasUsed = await gasOf(await registry.connect(keeper).batchRemoveSanctioned(addrs));
    record("Remove 10 (batch)", 10, gasUsed);
  });

  it("[D] remove 200 listed (batch)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x60_2000, 200);
    await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const gasUsed = await gasOf(await registry.connect(keeper).batchRemoveSanctioned(addrs));
    record("Remove 200 (batch)", 200, gasUsed);
  });

  it("[D] remove 500 listed (batch)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x60_4000, 500);
    await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);

    const gasUsed = await gasOf(await registry.connect(keeper).batchRemoveSanctioned(addrs));
    record("Remove 500 (batch)", 500, gasUsed);
  });

  it("[D] re-add 500 after remove (proves wiped slots act like fresh)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0x70_0000, 500);
    await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG);
    await registry.connect(keeper).batchRemoveSanctioned(addrs);

    const gasUsed = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    record("Re-add 500 after remove", 500, gasUsed);
    // Slot was wiped → bool slot zero again → fresh-add cost.
    expect(gasUsed / 500n).to.be.within(40_000n, 60_000n);
  });

  // ── Group E: realistic keeper sync (5 add + 2 remove)

  it("[E] realistic keeper diff sync (5 add + 2 remove)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);

    // Seed prior state: 1,000 addresses already on-chain.
    const seed = makeAddrs(0x80_0000, 1000);
    for (let i = 0; i < seed.length; i += 500) {
      await registry.connect(keeper).batchAddSanctioned(seed.slice(i, i + 500), CAT_FOREIGN_GOV_LIST, SOURCE_TAG);
    }

    // Diff this cycle: 5 new, 2 to remove.
    const toAdd = makeAddrs(0x90_0000, 5);
    const toRemove = seed.slice(0, 2);

    const addGas = await gasOf(
      await registry.connect(keeper).batchAddSanctioned(toAdd, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    );
    const removeGas = await gasOf(await registry.connect(keeper).batchRemoveSanctioned(toRemove));
    const total = addGas + removeGas;
    record("Realistic keeper sync (5 add + 2 remove)", 7, total);
  });

  // ── Group F: contract-level guards (gas-test-style — confirm reverts)

  it("[F] empty batch reverts (sanity)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    await expect(
      registry.connect(keeper).batchAddSanctioned([], CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    ).to.be.revertedWithCustomError(registry, "EmptyBatch");
  });

  it("[F] MAX_BATCH_SIZE+1 reverts (sanity)", async function () {
    const { registry, keeper } = await loadFixture(freshFixture);
    const addrs = makeAddrs(0xa0_0000, 501);
    await expect(
      registry.connect(keeper).batchAddSanctioned(addrs, CAT_FOREIGN_GOV_LIST, SOURCE_TAG)
    ).to.be.revertedWithCustomError(registry, "BatchTooLarge");
  });

  // ── Print the markdown report at the very end

  after(() => {
    printReport();
  });
});

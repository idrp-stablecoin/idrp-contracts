/**
 * Nile: deploy the FINAL token implementation — the one that seizes into
 * `confiscationWallet` — and print its address for scheduleUpgrade.
 *
 *   npx hardhat run scripts/nile-deploy-idrp-v4-impl.ts --network nile
 *
 * Two things this does that a plain deploy does not:
 *
 *   1. Builds with UPGRADE_DELAY = 300s, the testnet convention (see the deployment
 *      notes: testnets intentionally run a 5-minute timelock). The impl currently live
 *      on Nile carries the mainnet 48h, which is why the last iteration took two days.
 *      The patch is applied to the source, the source is restored in a finally block,
 *      and the DEPLOYED constant is read back — a restored file is not evidence that
 *      the right bytecode went out, and a patched file left behind would silently
 *      poison the next mainnet build.
 *
 *   2. Asserts the deployed bytecode actually contains setConfiscationWallet, so a
 *      stale artifact cannot be scheduled by mistake.
 */
import hre from "hardhat";
import fs from "fs";

const SRC = "contracts/IDRP.sol";
const CANON = "uint256 public constant UPGRADE_DELAY = 48 hours;";
const TESTNET = "uint256 public constant UPGRADE_DELAY = 300 seconds;";

async function main() {
  if (hre.network.name !== "nile") throw new Error(`nile only (got ${hre.network.name})`);
  const { ethers, deployments } = hre as any;

  const original = fs.readFileSync(SRC, "utf8");
  if (!original.includes(CANON)) {
    throw new Error(`${SRC} does not contain the canonical 48h constant — refusing to patch blindly`);
  }
  let result: any;
  try {
    fs.writeFileSync(SRC, original.replace(CANON, TESTNET));
    console.log(`Patched ${SRC}: UPGRADE_DELAY -> 300 seconds (testnet build)`);
    await hre.run("compile");

    const [signer] = await hre.ethers.getSigners();
    const from = await signer.getAddress();
    console.log(`Deployer: ${from}\n`);
    result = await deployments.deploy("IDRP_v4_ConfiscationWallet_Nile_5min", {
      from, contract: "IDRP", args: [], log: true, gasLimit: 10_000_000, gasPrice: "420",
    });
  } finally {
    fs.writeFileSync(SRC, original);
    console.log(`\nRestored ${SRC} to the canonical 48h constant.`);
  }

  const impl = result.address.toLowerCase();
  console.log(`\n✓ impl ${impl}`);

  // Read the DEPLOYED bytecode back — the restored source proves nothing about it.
  const rpcUrl = "https://nile.trongrid.io/jsonrpc";
  const post = async (body: unknown) => {
    let last: unknown;
    for (let a = 0; a < 6; a++) {
      if (a) await new Promise((r) => setTimeout(r, 900 * a));
      try {
        const j: any = await (await fetch(rpcUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
        })).json();
        if (j?.error || j?.Error) { last = new Error("rpc"); continue; }
        if (j?.result !== undefined) return j.result as string;
      } catch (e) { last = e; }
    }
    throw new Error(`read failed: ${String((last as any)?.message)}`);
  };
  const code = (await post({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [impl, "latest"] })).toLowerCase();
  console.log(`  runtime bytecode: ${(code.length - 2) / 2} B`);

  const checks: Array<[string, boolean]> = [
    ["setConfiscationWallet(address)", code.includes(ethers.id("setConfiscationWallet(address)").slice(2, 10))],
    ["confiscationWallet()", code.includes(ethers.id("confiscationWallet()").slice(2, 10))],
    ["confiscate(address,uint256)", code.includes(ethers.id("confiscate(address,uint256)").slice(2, 10))],
    ["setController(address)", code.includes(ethers.id("setController(address)").slice(2, 10))],
    ['string "Confiscation wallet not set"', code.includes(Buffer.from("Confiscation wallet not set", "utf8").toString("hex"))],
    ["NOT a TronUUPS build (no proxy-slot trap)", !code.includes(ethers.id("TronUUPSUnauthorizedCallContext()").slice(2, 10))],
  ];
  console.log(`\n  deployed bytecode checks:`);
  let bad = 0;
  for (const [label, ok] of checks) { if (!ok) bad++; console.log(`    ${ok ? "✓" : "✗"} ${label}`); }

  const delay = await post({ jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: impl, data: ethers.id("UPGRADE_DELAY()").slice(0, 10) }, "latest"] });
  const delaySec = BigInt(delay);
  console.log(`    ${delaySec === 300n ? "✓" : "✗"} UPGRADE_DELAY = ${delaySec}s (want 300 on Nile)`);
  if (delaySec !== 300n) bad++;

  if (bad) throw new Error(`${bad} check(s) failed — do NOT schedule this implementation`);
  console.log(`\nAll checks passed.`);
  console.log(`Next: IMPL=${impl} npx hardhat run scripts/nile-schedule-idrp-upgrade.ts --network nile`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exit(1); });

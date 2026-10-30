/**
 * What the v2 → v3 upgrade still costs on this network, measured, and whether the account
 * can pay for it. Read-only: run it before asking anyone for TRX or renting energy.
 *
 *   npx hardhat run scripts/tron-funding-check.ts --network tron        (or nile | tre)
 *   ACCOUNT=T… npx hardhat run scripts/tron-funding-check.ts --network tron
 *
 * ACCOUNT defaults to the signer. On mainnet set it to the upgrader, which signs and pays
 * for every step.
 *
 * It reads both proxies and lists only the steps that are still to do:
 *   session A  cancel a pending schedule that is not a v3 build · deploy each implementation
 *              · schedule each
 *   session B  (after the delay) the two atomic upgradeToAndCall calls
 * Deploys and schedules are measured exactly with the node's estimator. The executes can
 * only be measured once their schedules mature; until then the line uses the local-TVM
 * measurement and is labelled as such. Every step script runs its own gate again before it
 * sends, so this is for planning, not a substitute.
 */
import hre from "hardhat";
import { ethers } from "ethers";
import { tronNetwork, base58Of, type TronNet } from "./utils/tron-network";
import { accountResources, assess, bandwidthOf, chainPrices, simulate, ENERGY_MARGIN, FEE_LIMIT_FACTOR, type Resources } from "./utils/tron-preflight";
import { assertArtifactIsBuild, checkImplementation, KINDS, type Kind } from "./utils/tron-impl";
import { proxyState } from "./utils/tron-steps";

/** Local-TVM receipts of the two executes (scripts/tre-authority-transfer.ts, 2026-09-23). */
const EXECUTE_ENERGY_TRE: Record<Kind, number> = { controller: 88_718, token: 82_406 };
const EXECUTE_BYTES = 571; // the mainnet 2026-09-01 upgradeToAndCall receipt, the same call shape

type Line = { session: "A" | "B"; label: string; energy: number; bandwidth: number; measured: boolean };

const n = (v: number) => v.toLocaleString("en-US");
const trx = (sun: number) => (sun / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function isV3Build(net: TronNet, impl: string, kind: Kind) {
  try {
    await checkImplementation(net, impl, kind);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const net = await tronNetwork(hre);
  const account: string = process.env.ACCOUNT ?? net.signer;
  const prices = await chainPrices(net);
  const lines: Line[] = [];
  const dummy = "0x000000000000000000000000000000000000dEaD";

  console.log(`network   ${net.name} — ${net.label}`);
  console.log(`account   ${account}${account === net.signer ? " (signer)" : ""}`);
  console.log(`prices    ${n(prices.energyFee)} sun/energy, ${n(prices.txFee)} sun/byte, max fee limit ${trx(prices.maxFeeLimit)} TRX\n`);

  await hre.run("compile", { quiet: true });
  for (const kind of ["controller", "token"] as Kind[]) {
    const s = await proxyState(net, kind);
    const upgraderT = base58Of(net, s.upgrader);
    const name = KINDS[kind].name;
    if (await isV3Build(net, base58Of(net, s.implementation), kind)) {
      console.log(`${name}: already on a v3 build — nothing to do`);
      continue;
    }
    if (upgraderT !== account) console.log(`⚠ ${name}: the upgrader is ${upgraderT}, not ${account}; it signs the schedule and execute steps.`);

    let pendingIsV3 = false;
    if (s.scheduled) {
      pendingIsV3 = await isV3Build(net, base58Of(net, s.scheduled), kind);
      if (!pendingIsV3) {
        const sim = await simulate(net, { owner: upgraderT, contract: s.proxy, selector: "cancelUpgrade()", parameter: "" });
        if (!sim.ok) throw new Error(`${name}.cancelUpgrade() from the upgrader would revert: ${sim.reason}`);
        const tx = await net.tw.transactionBuilder.triggerSmartContract(net.tw.address.toHex(s.proxy), "cancelUpgrade()",
          { feeLimit: Math.ceil(sim.energy * FEE_LIMIT_FACTOR) * prices.energyFee, callValue: 0, rawParameter: "" }, [], net.tw.address.toHex(upgraderT));
        lines.push({ session: "A", label: `${name}: cancel ${base58Of(net, s.scheduled)} (not a v3 build)`, energy: sim.energy, bandwidth: bandwidthOf(tx.transaction), measured: true });
      }
    }
    if (!pendingIsV3) {
      const { artifact } = await assertArtifactIsBuild(hre, kind, net.delayText).catch(async (e) => {
        if (net.isMainnet) throw e;
        // testnet builds are made by testnet-upgrade-tron.ts; the committed 48 h artifact is the same size to within bytes
        console.log(`  (${name}: measuring the committed build; the ${net.delayText} build differs only in its delay constants)`);
        return { artifact: await hre.artifacts.readArtifact(KINDS[kind].fqn) };
      });
      const sim = await simulate(net, { owner: account, data: artifact.bytecode });
      if (!sim.ok) throw new Error(`deploying ${name} would fail: ${sim.reason}`);
      const tx = await net.tw.transactionBuilder.createSmartContract({
        abi: { entrys: artifact.abi }, bytecode: artifact.bytecode.replace(/^0x/, ""), name,
        feeLimit: Math.ceil(sim.energy * FEE_LIMIT_FACTOR) * prices.energyFee, callValue: 0, userFeePercentage: 100, originEnergyLimit: 10_000_000,
      }, net.tw.address.toHex(account));
      lines.push({ session: "A", label: `${name}: deploy the v3 implementation`, energy: sim.energy, bandwidth: bandwidthOf(tx), measured: true });

      // scheduleUpgrade from an empty slot writes two zero words to non-zero: measure exactly that.
      const parameter = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [dummy]).slice(2);
      const schedSim = await simulate(net, { owner: upgraderT, contract: s.proxy, selector: "scheduleUpgrade(address)", parameter });
      if (!schedSim.ok) throw new Error(`${name}.scheduleUpgrade from the upgrader would revert: ${schedSim.reason}`);
      const st = await net.tw.transactionBuilder.triggerSmartContract(net.tw.address.toHex(s.proxy), "scheduleUpgrade(address)",
        { feeLimit: Math.ceil(schedSim.energy * FEE_LIMIT_FACTOR) * prices.energyFee, callValue: 0, rawParameter: parameter }, [], net.tw.address.toHex(upgraderT));
      const fromEmpty = s.scheduled ? " (measured over the pending one; from an empty slot it costs more — cancel first)" : "";
      lines.push({ session: "A", label: `${name}: scheduleUpgrade${fromEmpty}`, energy: schedSim.energy, bandwidth: bandwidthOf(st.transaction), measured: true });
    }
    lines.push({ session: "B", label: `${name}: upgradeToAndCall(initializeV3) — local-TVM figure, measure again when due`, energy: EXECUTE_ENERGY_TRE[kind], bandwidth: EXECUTE_BYTES, measured: false });
  }

  if (!lines.length) {
    console.log(`\nNothing left to pay for.`);
    return;
  }

  const res: Resources = await accountResources(net, account);
  console.log(`\naccount now: balance ${trx(res.balance)} TRX, energy left ${n(res.energyLeft)}, bandwidth left ${n(res.netLeft)} staked / ${n(res.freeNetLeft)} free\n`);
  console.log(`  ${"session".padEnd(8)}${"step".padEnd(78)}${"energy".padStart(12)}${"bytes".padStart(9)}${"burn TRX".padStart(11)}`);
  let total = { energy: 0, bandwidth: 0, sun: 0 };
  const perSession: Record<string, { energy: number; bandwidth: number; sun: number }> = {};
  for (const l of lines) {
    const sun = l.energy * prices.energyFee + l.bandwidth * prices.txFee;
    total = { energy: total.energy + l.energy, bandwidth: total.bandwidth + l.bandwidth, sun: total.sun + sun };
    const p = (perSession[l.session] ??= { energy: 0, bandwidth: 0, sun: 0 });
    p.energy += l.energy; p.bandwidth += l.bandwidth; p.sun += sun;
    console.log(`  ${l.session.padEnd(8)}${(l.label + (l.measured ? "" : " *")).padEnd(78)}${n(l.energy).padStart(12)}${n(l.bandwidth).padStart(9)}${trx(sun).padStart(11)}`);
  }
  for (const [k, v] of Object.entries(perSession)) {
    console.log(`  ${k.padEnd(8)}${"subtotal".padEnd(78)}${n(v.energy).padStart(12)}${n(v.bandwidth).padStart(9)}${trx(v.sun).padStart(11)}`);
  }
  console.log(`  ${"".padEnd(8)}${"TOTAL if everything is burned".padEnd(78)}${n(total.energy).padStart(12)}${n(total.bandwidth).padStart(9)}${trx(total.sun).padStart(11)}`);
  console.log(`  * not measurable before its schedule matures`);

  // Can the account carry the whole of session A as it stands now? Energy is spent in order, so pool it.
  const a = perSession.A;
  if (a) {
    const v = assess(a.energy, 0, { ...res, balance: Math.max(0, res.balance - a.bandwidth * prices.txFee) }, { ...prices, maxFeeLimit: Number.MAX_SAFE_INTEGER });
    const needBurn = a.bandwidth * prices.txFee + Math.max(0, Math.ceil(a.energy * ENERGY_MARGIN) - res.energyLeft) * prices.energyFee;
    console.log(`\nsession A as one budget (${ENERGY_MARGIN} x energy, bandwidth burned): ${v.ok ? "FUNDED ✓" : `NOT FUNDED ✗ — short by ${trx(Math.max(0, needBurn - res.balance))} TRX`}`);
    console.log(`  burn only: hold ≥ ${trx(needBurn + (perSession.B?.sun ?? 0) * ENERGY_MARGIN)} TRX for A and B`);
    console.log(`  renting:   ≥ ${n(Math.ceil(a.energy * ENERGY_MARGIN))} energy for session A, plus ≥ ${trx(a.bandwidth * prices.txFee + 50e6)} TRX for bandwidth and slack`);
  }
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

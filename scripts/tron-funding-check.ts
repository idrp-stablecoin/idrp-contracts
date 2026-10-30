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
 * It reads both proxies and lists only the steps that are still to do, in the runbook's
 * sessions (docs/upgrade/TRON-V3-MAINNET.md):
 *   1  cancel any pending schedule that is not a v3 build · deploy and schedule the controller
 *   2  (after the delay) execute the controller · deploy and schedule the token
 *   3  (after the delay) execute the token
 * Deploys, schedules and cancels are measured exactly with the node's estimator. The executes
 * can only be measured once their schedules mature; until then the line uses the receipts of
 * the same calls on the Nile testnet env and is labelled as such. Every step script runs its
 * own gate again before it sends, so this is for planning, not a substitute.
 */
import hre from "hardhat";
import { ethers } from "ethers";
import { tronNetwork, base58Of, type TronNet } from "./utils/tron-network";
import { accountResources, bandwidthOf, chainPrices, retrying, simulate, ENERGY_MARGIN, FEE_LIMIT_FACTOR, type Resources } from "./utils/tron-preflight";
import { assertArtifactIsBuild, checkImplementation, KINDS, type Kind } from "./utils/tron-impl";
import { proxyState } from "./utils/tron-steps";

/** Receipts of the two executes on the Nile testnet env (2026-10-30), the same calls mainnet makes. */
const EXECUTE_ENERGY: Record<Kind, number> = { controller: 88_718, token: 82_406 };
const EXECUTE_BYTES: Record<Kind, number> = { controller: 571, token: 507 };
/** scheduleUpgrade from an empty slot: the controller and token receipts on Nile (2026-10-30); mainnet's
 *  2026-06-30 token receipt is the same 42,578. Used when a cancel runs first, since today's slot is not empty. */
const SCHEDULE_FROM_EMPTY: Record<Kind, number> = { controller: 42_516, token: 42_578 };

type Line = { session: 1 | 2 | 3; label: string; energy: number; bandwidth: number; measured: boolean };
const DEPLOY_SESSION: Record<Kind, 1 | 2> = { controller: 1, token: 2 };

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
        const tx = await retrying("building cancelUpgrade", () => net.tw.transactionBuilder.triggerSmartContract(net.tw.address.toHex(s.proxy), "cancelUpgrade()",
          { feeLimit: Math.ceil(sim.energy * FEE_LIMIT_FACTOR) * prices.energyFee, callValue: 0, rawParameter: "" }, [], net.tw.address.toHex(upgraderT))) as any;
        lines.push({ session: 1, label: `${name}: cancel ${base58Of(net, s.scheduled)} (not a v3 build)`, energy: sim.energy, bandwidth: bandwidthOf(tx.transaction), measured: true });
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
      const tx = await retrying("building the deploy", () => net.tw.transactionBuilder.createSmartContract({
        abi: { entrys: artifact.abi }, bytecode: artifact.bytecode.replace(/^0x/, ""), name,
        feeLimit: Math.ceil(sim.energy * FEE_LIMIT_FACTOR) * prices.energyFee, callValue: 0, userFeePercentage: 100, originEnergyLimit: 10_000_000,
      }, net.tw.address.toHex(account))) as any;
      lines.push({ session: DEPLOY_SESSION[kind], label: `${name}: deploy the v3 implementation`, energy: sim.energy, bandwidth: bandwidthOf(tx), measured: true });

      // scheduleUpgrade from an empty slot writes two zero words to non-zero: measure exactly that.
      const parameter = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [dummy]).slice(2);
      const schedSim = await simulate(net, { owner: upgraderT, contract: s.proxy, selector: "scheduleUpgrade(address)", parameter });
      if (!schedSim.ok) throw new Error(`${name}.scheduleUpgrade from the upgrader would revert: ${schedSim.reason}`);
      const st = await retrying("building scheduleUpgrade", () => net.tw.transactionBuilder.triggerSmartContract(net.tw.address.toHex(s.proxy), "scheduleUpgrade(address)",
        { feeLimit: Math.ceil(schedSim.energy * FEE_LIMIT_FACTOR) * prices.energyFee, callValue: 0, rawParameter: parameter }, [], net.tw.address.toHex(upgraderT))) as any;
      // After the cancel the slot is empty again, and writing it from empty costs more than overwriting.
      const afterCancel = Boolean(s.scheduled);
      lines.push({
        session: DEPLOY_SESSION[kind],
        label: `${name}: scheduleUpgrade${afterCancel ? " (after the cancel: the from-empty receipt)" : ""}`,
        energy: afterCancel ? Math.max(schedSim.energy, SCHEDULE_FROM_EMPTY[kind]) : schedSim.energy,
        bandwidth: bandwidthOf(st.transaction),
        measured: !afterCancel,
      });
    }
    lines.push({ session: (DEPLOY_SESSION[kind] + 1) as 2 | 3, label: `${name}: upgradeToAndCall(initializeV3) — Nile figure, measured again when due`, energy: EXECUTE_ENERGY[kind], bandwidth: EXECUTE_BYTES[kind], measured: false });
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
  lines.sort((x, y) => x.session - y.session);
  for (const l of lines) {
    const sun = l.energy * prices.energyFee + l.bandwidth * prices.txFee;
    total = { energy: total.energy + l.energy, bandwidth: total.bandwidth + l.bandwidth, sun: total.sun + sun };
    const p = (perSession[l.session] ??= { energy: 0, bandwidth: 0, sun: 0 });
    p.energy += l.energy; p.bandwidth += l.bandwidth; p.sun += sun;
    console.log(`  ${String(l.session).padEnd(8)}${(l.label + (l.measured ? "" : " *")).padEnd(78)}${n(l.energy).padStart(12)}${n(l.bandwidth).padStart(9)}${trx(sun).padStart(11)}`);
  }
  for (const [k, v] of Object.entries(perSession)) {
    console.log(`  ${k.padEnd(8)}${"subtotal".padEnd(78)}${n(v.energy).padStart(12)}${n(v.bandwidth).padStart(9)}${trx(v.sun).padStart(11)}`);
  }
  console.log(`  ${"".padEnd(8)}${"TOTAL if everything is burned".padEnd(78)}${n(total.energy).padStart(12)}${n(total.bandwidth).padStart(9)}${trx(total.sun).padStart(11)}`);
  console.log(`  * not measurable on this chain yet: the receipt of the same call elsewhere (see the label)`);

  // What each session needs as one budget (energy is spent in order, so pool it), and whether the
  // account covers the next one as it stands now. Bandwidth is assumed burned: a deploy cannot use
  // free or rented bandwidth.
  console.log(`\nper session (${ENERGY_MARGIN} x energy):`);
  let next = true;
  for (const [k, v] of Object.entries(perSession)) {
    const energy = Math.ceil(v.energy * ENERGY_MARGIN);
    const burnOnly = v.bandwidth * prices.txFee + energy * prices.energyFee;
    const line = `  session ${k}: burn only ≥ ${trx(burnOnly)} TRX, or rent ≥ ${n(energy)} energy and hold ≥ ${trx(v.bandwidth * prices.txFee + 50e6)} TRX`;
    if (next) {
      const short = Math.max(0, v.bandwidth * prices.txFee + Math.max(0, energy - res.energyLeft) * prices.energyFee - res.balance);
      console.log(`${line}\n             the account now: ${short === 0 ? "FUNDED ✓" : `NOT FUNDED ✗ — short by ${trx(short)} TRX (burn only)`}`);
      next = false;
    } else {
      console.log(line);
    }
  }
  console.log(`  everything, burn only: ≥ ${trx(Math.ceil(total.energy * ENERGY_MARGIN) * prices.energyFee + total.bandwidth * prices.txFee)} TRX`);
}

main().catch((e) => { console.error(`\n✗ ${e.message ?? e}`); process.exitCode = 1; });

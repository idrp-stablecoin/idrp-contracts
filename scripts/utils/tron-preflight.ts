/**
 * The funding gate every Tron write goes through.
 *
 * WHY
 *   On Tron the fee limit is a cap, not a reservation. When the fee limit is higher than
 *   the balance, the BALANCE becomes the energy cap, and a transaction that runs out of
 *   energy keeps everything it consumed. Underfunded implementation deploys burned the
 *   whole balance twice (2026-06-29: 311.68 TRX, 2026-09-03: 264.88 TRX) and deployed
 *   nothing. A sentence in a runbook did not stop either; this check does.
 *
 * WHAT IT DOES, per transaction
 *   1. Measures the energy with the node's own estimator (triggerconstantcontract, which
 *      reproduces the receipts of past deploys to the unit) and refuses a call that
 *      reverts.
 *   2. Builds the exact unsigned transaction, so the bandwidth is its real size.
 *   3. Reads the account's balance, staked/rented energy and bandwidth, and the chain's
 *      prices, and works out what the node will allow:
 *        bandwidth: staked, else free, else burned in full (all or nothing per tx)
 *        energy cap: min(energy left + (balance - bandwidth burn) / energy price,
 *                        fee limit / energy price)
 *      It passes only if that cap covers ENERGY_MARGIN x the measured energy.
 *   4. Sets the fee limit to FEE_LIMIT_FACTOR x the measured energy, so even a wrong
 *      estimate cannot spend more than that.
 *   5. Without EXECUTE=1 it prints all of this and sends nothing (a dry run). With
 *      EXECUTE=1 it refuses unless funded, then signs, broadcasts, waits for the receipt
 *      and prints what was really used next to what was measured.
 */
import type { TronNet } from "./tron-network";
import { walletApi, jsonRpc } from "./tron-network";
import { ethers } from "ethers";

export const ENERGY_MARGIN = 1.1;
export const FEE_LIMIT_FACTOR = 1.2;

export const EXECUTE = process.env.EXECUTE === "1";

export type Prices = { energyFee: number; txFee: number; maxFeeLimit: number };
export type Resources = {
  address: string;
  balance: number;
  energyLeft: number;
  netLeft: number;
  freeNetLeft: number;
};
export type Sim = { ok: boolean; energy: number; reason: string; result: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trx = (sun: number) => (sun / 1e6).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const n = (v: number) => v.toLocaleString("en-US");

const TRANSIENT = /\b429\b|Too Many Requests|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network error|timeout/i;

/**
 * Retries a TronWeb call that failed in transport (TronGrid's free tier answers 429 under any
 * burst). Anything else — a validation error, a revert — is thrown at once.
 */
export async function retrying<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (!TRANSIENT.test(`${e?.message ?? e} ${e?.response?.status ?? ""}`)) throw e;
    }
    await sleep(1500 * (a + 1));
  }
  throw new Error(`${label} failed after retries: ${(last as any)?.message ?? last}`);
}

export async function chainPrices(net: TronNet): Promise<Prices> {
  const r = await walletApi(net, "wallet/getchainparameters", {}, (x) => Array.isArray(x?.chainParameter));
  const get = (key: string) => {
    const e = r.chainParameter.find((p: any) => p.key === key);
    if (!e) throw new Error(`chain parameter ${key} missing`);
    return Number(e.value ?? 0); // the node omits `value` when it is 0
  };
  const p = { energyFee: get("getEnergyFee"), txFee: get("getTransactionFee"), maxFeeLimit: get("getMaxFeeLimit") };
  if (!(p.energyFee > 0)) throw new Error(`energy price reads ${p.energyFee} — refusing to reason about fees`);
  return p;
}

export async function accountResources(net: TronNet, address: string): Promise<Resources> {
  // An account that never held TRX answers {} — a real answer. A transport failure throws.
  const acct = await walletApi(net, "wallet/getaccount", { address, visible: true });
  const res = await walletApi(net, "wallet/getaccountresource", { address, visible: true });
  const num = (v: unknown) => Number(v ?? 0);
  return {
    address,
    balance: num(acct.balance),
    energyLeft: Math.max(0, num(res.EnergyLimit) - num(res.EnergyUsed)),
    netLeft: Math.max(0, num(res.NetLimit) - num(res.NetUsed)),
    freeNetLeft: Math.max(0, num(res.freeNetLimit) - num(res.freeNetUsed)),
  };
}

function decodeMessage(m: unknown): string {
  const s = String(m ?? "");
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    const t = Buffer.from(s, "hex").toString("utf8");
    if (/^[\x20-\x7e]+$/.test(t)) return t;
  }
  return s;
}

/** Turns revert data into words: Error(string), Panic(uint256), or a custom error the interface knows. */
export function decodeRevert(data: string, iface?: ethers.Interface): string {
  const hex = data.replace(/^0x/, "");
  if (!hex) return "(no revert data)";
  if (hex.startsWith("08c379a0")) {
    try { return String(ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(8))[0]); } catch { /* fall through */ }
  }
  if (hex.startsWith("4e487b71")) {
    try { return `Panic(${ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + hex.slice(8))[0]})`; } catch { /* fall through */ }
  }
  if (iface) {
    try {
      const e = iface.parseError("0x" + hex);
      if (e) return `${e.name}(${e.args.join(",")})`;
    } catch { /* unknown */ }
  }
  return `0x${hex.slice(0, 8)} (custom error)`;
}

/**
 * Runs the transaction on the node without sending it. A deploy is `data` = initcode
 * with no contract address; a call is the contract plus its selector and parameters.
 * A revert is a real answer (ok=false with the reason). A response with neither a
 * result nor `constant_result` (TronGrid under rate limit) is retried, never read as
 * success.
 */
export async function simulate(
  net: TronNet,
  req: { owner: string; contract?: string; selector?: string; parameter?: string; data?: string },
  iface?: ethers.Interface,
): Promise<Sim> {
  const body: any = { owner_address: req.owner, visible: true };
  if (req.contract) {
    body.contract_address = req.contract;
    body.function_selector = req.selector;
    body.parameter = req.parameter ?? "";
  } else {
    body.data = (req.data ?? "").replace(/^0x/, "");
  }
  const r = await walletApi(net, "wallet/triggerconstantcontract", body, (x) => x && (Array.isArray(x.constant_result) || x.result?.message || x.result?.code));
  const result = String(r.constant_result?.[0] ?? "");
  const message = decodeMessage(r.result?.message);
  const failed = r.transaction?.ret?.[0]?.ret === "FAILED";
  if (r.result?.code && r.result.code !== "SUCCESS") {
    return { ok: false, energy: Number(r.energy_used ?? 0), reason: `${r.result.code}: ${message}`, result };
  }
  if (message || failed) {
    return { ok: false, energy: Number(r.energy_used ?? 0), reason: result ? decodeRevert(result, iface) : message || "reverted", result };
  }
  if (r.energy_used === undefined) throw new Error("triggerconstantcontract returned no energy_used");
  return { ok: true, energy: Number(r.energy_used), reason: "", result };
}

/** Bytes the node charges for a signed transaction: raw_data + one signature + the 64-byte result allowance. */
export function bandwidthOf(unsigned: any): number {
  const raw = String(unsigned.raw_data_hex ?? "").length / 2;
  if (!raw) throw new Error("unsigned transaction has no raw_data_hex");
  let varint = 1;
  for (let v = raw; v >= 0x80; v >>= 7) varint++;
  return raw + varint + 1 /* tag */ + 1 + 1 + 65 /* signature field */ + 64 /* MAX_RESULT_SIZE_IN_TX */;
}

export type Verdict = {
  ok: boolean;
  energy: number;
  bandwidth: number;
  feeLimit: number;
  bandwidthBurn: number;
  energyFromStake: number;
  energyBurn: number;
  capacity: number;
  required: number;
  shortfall: number;
  why: string[];
};

export function assess(energy: number, bandwidth: number, res: Resources, p: Prices): Verdict {
  const why: string[] = [];
  const bandwidthBurn = res.netLeft >= bandwidth || res.freeNetLeft >= bandwidth ? 0 : bandwidth * p.txFee;
  const feeLimit = Math.ceil(energy * FEE_LIMIT_FACTOR) * p.energyFee;
  const fromBalance = Math.floor(Math.max(0, res.balance - bandwidthBurn) / p.energyFee);
  const capacity = Math.min(res.energyLeft + fromBalance, Math.floor(feeLimit / p.energyFee));
  const required = Math.ceil(energy * ENERGY_MARGIN);
  const energyFromStake = Math.min(res.energyLeft, energy);
  const energyBurn = (energy - energyFromStake) * p.energyFee;
  if (res.balance < bandwidthBurn) why.push(`balance ${trx(res.balance)} TRX < bandwidth burn ${trx(bandwidthBurn)} TRX`);
  if (capacity < required) why.push(`energy the node would allow ${n(capacity)} < required ${n(required)} (${ENERGY_MARGIN} x measured)`);
  if (feeLimit > p.maxFeeLimit) why.push(`fee limit ${trx(feeLimit)} TRX > chain maximum ${trx(p.maxFeeLimit)} TRX`);
  const shortfall = Math.max(0, bandwidthBurn + Math.max(0, required - res.energyLeft) * p.energyFee - res.balance);
  return { ok: why.length === 0, energy, bandwidth, feeLimit, bandwidthBurn, energyFromStake, energyBurn, capacity, required, shortfall, why };
}

export function printVerdict(label: string, v: Verdict, res: Resources, p: Prices) {
  const lines = [
    `  step          ${label}`,
    `  energy        ${n(v.energy)} (measured)`,
    `  bandwidth     ${n(v.bandwidth)} B (the exact transaction, signed)`,
    `  prices        ${n(p.energyFee)} sun/energy, ${n(p.txFee)} sun/byte, max fee limit ${trx(p.maxFeeLimit)} TRX`,
    `  account       ${res.address}`,
    `                balance ${trx(res.balance)} TRX, energy left ${n(res.energyLeft)}, bandwidth left ${n(res.netLeft)} staked / ${n(res.freeNetLeft)} free`,
    `  will pay      bandwidth ${v.bandwidthBurn ? trx(v.bandwidthBurn) + " TRX burned" : "from staked/free"}, energy ${n(v.energyFromStake)} from stake + ${trx(v.energyBurn)} TRX burned`,
    `                = ${trx(v.bandwidthBurn + v.energyBurn)} TRX from the balance`,
    `  fee limit     ${trx(v.feeLimit)} TRX (${FEE_LIMIT_FACTOR} x measured) — the most this transaction can cost`,
    `  node allows   ${n(v.capacity)} energy, needs ${n(v.required)} (${ENERGY_MARGIN} x measured)`,
    v.ok ? `  funding       FUNDED ✓` : `  funding       NOT FUNDED ✗ — short by ${trx(v.shortfall)} TRX\n${v.why.map((w) => "                - " + w).join("\n")}`,
  ];
  console.log(lines.join("\n"));
}

export async function waitReceipt(net: TronNet, txid: string, label: string, timeoutMs = 180_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let info: any;
    try { info = await net.tw.trx.getTransactionInfo(txid); } catch { info = undefined; }
    if (info && (info.blockNumber || info.id)) return info;
    await sleep(2000);
  }
  throw new Error(`${label}: no receipt for ${txid} after ${timeoutMs / 1000}s — look it up before retrying anything`);
}

export type Step = {
  label: string;
  /** Measured energy for this transaction. */
  energy: number;
  /** Builds the unsigned transaction with the given fee limit (sun). */
  build: (feeLimit: number) => Promise<any>;
  iface?: ethers.Interface;
};

/**
 * Measures, prints and (only with EXECUTE=1 and only when funded) sends one transaction.
 * Returns the receipt, or undefined on a dry run. Throws when not funded under EXECUTE=1.
 */
export async function gatedSend(net: TronNet, step: Step): Promise<any | undefined> {
  const prices = await chainPrices(net);
  const res = await accountResources(net, net.signer);
  const feeLimit = Math.ceil(step.energy * FEE_LIMIT_FACTOR) * prices.energyFee;
  const unsigned = await retrying(`${step.label}: building the transaction`, () => step.build(feeLimit));
  if (Number(unsigned?.raw_data?.fee_limit) !== feeLimit) {
    throw new Error(`${step.label}: the built transaction has fee_limit ${unsigned?.raw_data?.fee_limit}, expected ${feeLimit}`);
  }
  const v = assess(step.energy, bandwidthOf(unsigned), res, prices);
  console.log("");
  printVerdict(step.label, v, res, prices);

  if (!EXECUTE) {
    console.log(`  mode          DRY RUN — nothing sent. Re-run with EXECUTE=1 to broadcast.`);
    if (!v.ok) process.exitCode = 1;
    return undefined;
  }
  if (!v.ok) throw new Error(`REFUSED: ${step.label} is not funded (short by ${trx(v.shortfall)} TRX). Nothing was sent.`);

  const signed = await net.tw.trx.sign(unsigned);
  // The same signed transaction can be re-broadcast safely: a node that already has it answers
  // DUP_TRANSACTION_ERROR for the same txID, which means it was sent.
  const sent: any = await retrying(`${step.label}: broadcasting`, () => net.tw.trx.sendRawTransaction(signed));
  if (!sent?.result && sent?.code !== "DUP_TRANSACTION_ERROR") {
    throw new Error(`${step.label}: the node rejected the transaction: ${JSON.stringify(sent)}`);
  }
  console.log(`  sent          ${unsigned.txID}`);
  const info = await waitReceipt(net, unsigned.txID, step.label);
  const r = info.receipt ?? {};
  const usedEnergy = Number(r.energy_usage_total ?? 0);
  const usedNet = Number(r.net_usage ?? 0) || Number(r.net_fee ?? 0) / prices.txFee;
  console.log(`  receipt       ${r.result ?? "?"} in block ${info.blockNumber}`);
  console.log(`  used          energy ${n(usedEnergy)} (measured ${n(step.energy)}), bandwidth ${n(usedNet)} B (measured ${n(v.bandwidth)}), fee ${trx(Number(info.fee ?? 0))} TRX`);
  if (r.result !== "SUCCESS") {
    const reason = info.contractResult?.[0] ? decodeRevert(info.contractResult[0], step.iface) : decodeMessage(info.resMessage);
    throw new Error(`${step.label} FAILED on chain: ${r.result} ${reason} (tx ${unsigned.txID})`);
  }
  return info;
}

/** eth_call through the node's JSON-RPC. Reverts come back as null; transport failures throw. */
export async function ethCall(net: TronNet, toHex: string, data: string, fromHex?: string): Promise<string | null> {
  const body = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ ...(fromHex ? { from: fromHex } : {}), to: toHex, data }, "latest"] };
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const j: any = await fetch(`${net.host}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...net.headers },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (j.result !== undefined) return j.result;
      if (j.error && /revert/i.test(String(j.error.message))) return null;
    } catch { /* retry */ }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`eth_call to ${toHex} failed after retries`);
}

export async function getCode(net: TronNet, hex: string): Promise<string> {
  return jsonRpc(net.host, net.headers, "eth_getCode", [hex, "latest"]);
}

export async function getStorage(net: TronNet, hex: string, slot: string): Promise<string> {
  return jsonRpc(net.host, net.headers, "eth_getStorageAt", [hex, slot, "latest"]);
}

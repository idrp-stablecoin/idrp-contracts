/**
 * Which Tron network a script is talking to, and which proxies it may touch there.
 *
 *   --network tron  Tron mainnet. Proxies from deployment/tron/mainnet.json. Timelocks 48 h.
 *   --network nile  The testnet env on Nile: mainnet's features and logic, 5-minute timelocks.
 *                   Proxies from deployment/testnet/tron/nile.json, which exists only on the
 *                   testnet line, so Nile runs from that trunk.
 *   --network tre   A local TVM (docker run -d -p 9090:9090 tronbox/tre). Proxies from the
 *                   record a local rehearsal wrote: TRE_RECORD=<path to its json>.
 *
 * The chain id is read from the node and must match the network name, so a wrong
 * --network cannot reach the wrong chain. The signing key is the network's first
 * configured account.
 */
import fs from "fs";
import path from "path";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require("tronweb");

export const MAINNET_CHAIN_ID = 728126428;
export const NILE_CHAIN_ID = 3448148188;

export type TronNetName = "tron" | "nile" | "tre";

export type TronNet = {
  name: TronNetName;
  label: string;
  host: string;
  headers: Record<string, string>;
  chainId: number;
  tw: any;
  signer: string;
  signerHex: string;
  recordPath: string;
  buildsDir: string;
  record: any;
  token: string;
  controller: string;
  /** Every timelock constant on this network's builds: UPGRADE_DELAY and the handover delays. */
  delaySeconds: number;
  /** The text the build uses for those constants. */
  delayText: string;
  isMainnet: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tronNetName(hre: HardhatRuntimeEnvironment): TronNetName {
  const name = hre.network.name;
  if (name !== "tron" && name !== "nile" && name !== "tre") {
    throw new Error(`Tron networks only: --network tron | nile | tre (got "${name}")`);
  }
  return name;
}

export async function jsonRpc(host: string, headers: Record<string, string>, method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const body = await fetch(`${host}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json());
      if (body.result !== undefined) return body.result;
      last = body.error ?? body;
    } catch (e) {
      last = e;
    }
    await sleep(1000 * (attempt + 1));
  }
  // A read that failed is not an answer. Never let it pass as a value.
  throw new Error(`${method} failed after retries: ${JSON.stringify(last)}`);
}

/** POST to a full-node HTTP endpoint (wallet/...). Retries transport failures and 429s. */
export async function walletApi(net: Pick<TronNet, "host" | "headers">, endpoint: string, body: unknown, accept: (r: any) => boolean = () => true): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(`${net.host}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...net.headers },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (r.ok) {
        const parsed = text ? JSON.parse(text) : {};
        if (accept(parsed)) return parsed;
        last = parsed;
      } else {
        last = `${r.status} ${text.slice(0, 200)}`;
      }
    } catch (e) {
      last = e;
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`${endpoint} failed after retries: ${typeof last === "string" ? last : JSON.stringify(last)}`);
}

function readRecord(file: string, hint: string) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found. ${hint}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Resolves the network, the proxies and the signer. Throws before anything is read
 * from a chain whose id doesn't match the network name.
 */
export async function tronNetwork(hre: HardhatRuntimeEnvironment): Promise<TronNet> {
  const name = tronNetName(hre);
  const cfg = hre.network.config as any;
  const host = String(cfg.url).replace(/\/jsonrpc\/?$/, "");
  const headers: Record<string, string> = cfg.httpHeaders ?? {};
  const root = hre.config.paths.root;

  let recordPath: string;
  let buildsDir: string;
  let label: string;
  let delaySeconds: number;
  let delayText: string;
  if (name === "tron") {
    label = "TRON MAINNET";
    recordPath = path.join(root, "deployment/tron/mainnet.json");
    buildsDir = path.join(root, "deployment/builds", String(MAINNET_CHAIN_ID));
    delaySeconds = 48 * 3600;
    delayText = "48 hours";
  } else if (name === "nile") {
    label = "Nile — testnet env (sandbox)";
    recordPath = path.join(root, "deployment/testnet/tron/nile.json");
    buildsDir = path.join(root, "deployment/builds", String(NILE_CHAIN_ID));
    delaySeconds = 300;
    delayText = "5 minutes";
  } else {
    label = "local TVM (tre)";
    const p = process.env.TRE_RECORD;
    if (!p) throw new Error("--network tre needs TRE_RECORD=<path to the record a local rehearsal wrote>");
    recordPath = path.resolve(p);
    // testnet-deploy-tron.ts --network tre writes <dir>/testnet/tron/tre.json and <dir>/builds/<chainId>/;
    // the chain id is appended below, once the node has answered.
    buildsDir = path.join(path.dirname(path.dirname(path.dirname(recordPath))), "builds");
    delaySeconds = 300;
    delayText = "5 minutes";
  }
  const record = readRecord(
    recordPath,
    name === "nile"
      ? "The Nile testnet env is deployed and upgraded from the tron-testnet trunk; check it out there."
      : "Is this the right branch?",
  );
  for (const key of ["IDRP", "IDRPController"]) {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(record[key] ?? "")) throw new Error(`${recordPath}: ${key} is not a base58 address`);
  }

  const chainId = Number(await jsonRpc(host, headers, "eth_chainId", []));
  if (name === "tron" && chainId !== MAINNET_CHAIN_ID) throw new Error(`REFUSING: chain id ${chainId} is not Tron mainnet (${MAINNET_CHAIN_ID})`);
  if (name === "nile" && chainId !== NILE_CHAIN_ID) throw new Error(`REFUSING: chain id ${chainId} is not Nile (${NILE_CHAIN_ID})`);
  if (name === "tre" && (chainId === MAINNET_CHAIN_ID || chainId === NILE_CHAIN_ID)) {
    throw new Error(`REFUSING: --network tre answered with chain id ${chainId}, a public chain`);
  }
  if (name === "tre" && record.chainId !== undefined && Number(record.chainId) !== chainId) {
    throw new Error(`REFUSING: ${recordPath} was written on chain ${record.chainId}, this node is ${chainId} (a new TRE container?)`);
  }

  if (name === "tre") buildsDir = path.join(buildsDir, String(chainId));

  const pk = String(cfg.accounts?.[0] ?? "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`--network ${name} has no usable signing key configured`);
  const tw = new TronWeb({ fullHost: host, headers, privateKey: pk });
  const signer: string = tw.address.fromPrivateKey(pk);
  const signerHex = ("0x" + tw.address.toHex(signer).slice(2)).toLowerCase();

  return {
    name, label, host, headers, chainId, tw, signer, signerHex, recordPath, buildsDir, record,
    token: record.IDRP, controller: record.IDRPController,
    delaySeconds, delayText, isMainnet: name === "tron",
  };
}

/** base58 or 0x-hex in, lowercase 0x-hex out. Only for addresses read from a chain or a record. */
export function hexOf(net: Pick<TronNet, "tw">, address: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return address.toLowerCase();
  const raw: string = net.tw.address.toHex(address);
  if (raw.length !== 42 || !raw.startsWith("41")) throw new Error(`not a Tron address: ${address}`);
  return ("0x" + raw.slice(2)).toLowerCase();
}

export function base58Of(net: Pick<TronNet, "tw">, hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, "").replace(/^41(?=[0-9a-f]{40}$)/, "");
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`not a 20-byte address: ${hex}`);
  return net.tw.address.fromHex("41" + h);
}

/** Appends to the record's `upgrades` list and rewrites the file. */
export function recordUpgradeEvent(net: TronNet, entry: Record<string, unknown>) {
  const record = JSON.parse(fs.readFileSync(net.recordPath, "utf8"));
  record.upgrades = [...(record.upgrades ?? []), { ...entry, at: new Date().toISOString() }];
  fs.writeFileSync(net.recordPath, JSON.stringify(record, null, 2) + "\n");
  net.record = record;
}

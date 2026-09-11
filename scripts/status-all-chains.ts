/**
 * Live status of every IDRP deployment: EVM + TVM, token + controller.
 *
 *   npx hardhat run scripts/status-all-chains.ts --network hardhat
 *
 * Everything is read from the chain at the current block and from DEPLOYED bytecode.
 * Nothing is taken from deployment/chain-*.json except the proxy addresses, because those
 * files drift (scheduled-upgrade fields especially). A read that fails is reported as FAILED,
 * never defaulted to a value — a missing feature and an unreachable RPC must not look alike.
 *
 * Feature detection uses several independent signals per contract, not one selector.
 */
import hre from "hardhat";

const I1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type Chain = { name: string; kind: "EVM" | "TVM"; net: "mainnet" | "testnet"; rpc: string; token?: string; ctrl?: string; ctrlOld?: string };
const CHAINS: Chain[] = [
  { name: "Ethereum",     kind: "EVM", net: "mainnet", rpc: "https://ethereum-rpc.publicnode.com",
    token: "0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56", ctrl: "0x9cB9AE7480ee98A41373100d4304194043f02c9d" },
  { name: "Polygon",      kind: "EVM", net: "mainnet", rpc: "https://polygon-bor-rpc.publicnode.com",
    token: "0xADb603C1D0a1b3943C9df35a50099f22fEaCaA58", ctrl: "0x877538747fe8acb657C1a54A759A8e4B9cC987Bc" },
  { name: "BSC",          kind: "EVM", net: "mainnet", rpc: "https://bsc-rpc.publicnode.com",
    token: "0x817d0C3D4e63231d88B2d73217B7fB75b87e0606", ctrl: "0x466d7B865e394f640aa436a399A464f7dC65C410" },
  { name: "Kaia",         kind: "EVM", net: "mainnet", rpc: "https://public-en.node.kaia.io",
    token: "0xC16d986585407A74Ab87d17C3d0Dc19822E3EB35", ctrl: "0xA2A8337eBc5d8553BFa12749eaB6b4bEAAc9137d" },
  { name: "Base Sepolia", kind: "EVM", net: "testnet", rpc: "https://sepolia.base.org",
    token: "0x817d0C3D4e63231d88B2d73217B7fB75b87e0606", ctrl: "0x466d7B865e394f640aa436a399A464f7dC65C410" },
  { name: "Kairos",       kind: "EVM", net: "testnet", rpc: "https://public-en-kairos.node.kaia.io",
    token: "0x999f947F3c7C0cF64AE53571a7fda51ce7f66164", ctrl: "0x38f94bf4D2D4f4a8E9f35606071DA7A51E92D26A" },
  { name: "Sepolia",      kind: "EVM", net: "testnet", rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    token: "0x08d7CfA7ea2a49254eE5374EB3d24037Ff6408c0", ctrl: "0xbBd0C476A3c4b88B1728f08f54291c466c3E18a3" },
  { name: "Tron",         kind: "TVM", net: "mainnet", rpc: "https://api.trongrid.io/jsonrpc",
    token: "0xa270dfc7cb955b0fc54beb8b570fd6b1ee4ea7fc", ctrl: "0xb43e4b7ef286bc075d4ca6acd33450af635649f4" },
  { name: "Nile",         kind: "TVM", net: "testnet", rpc: "https://nile.trongrid.io/jsonrpc",
    token: "0xf8a0c0078a0ac425f91240432ca90b9205b669ed",
    ctrl: "0x7a43a5367fed01f21468f6e38757013f684f1499",
    ctrlOld: "0xe0c7ce95aa4e7605b84332916a2e5d5d78d7ea51" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hexStr = (s: string) => Buffer.from(s, "utf8").toString("hex");

async function rpc(url: string, method: string, params: unknown[], label: string): Promise<string> {
  let last: unknown;
  for (let a = 0; a < 5; a++) {
    if (a) await sleep(900 * a);
    try {
      const j: any = await (await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000),
      })).json();
      if (j?.error || j?.Error) { last = new Error(JSON.stringify(j.error ?? j.Error).slice(0, 80)); continue; }
      if (j?.result === undefined) { last = new Error("no result field"); continue; }
      return j.result as string;
    } catch (e) { last = e; }
  }
  throw new Error(`FAILED ${label}: ${String((last as any)?.message).slice(0, 70)}`);
}

async function classify(c: Chain, which: "token" | "ctrl" | "ctrlOld", proxy: string) {
  const { ethers } = hre;
  const out: Record<string, string> = {};
  const implWord = await rpc(c.rpc, "eth_getStorageAt", [proxy, I1967, "latest"], `${c.name} ${which} 1967`);
  const impl = "0x" + implWord.slice(26);
  out.impl = impl;
  const code = (await rpc(c.rpc, "eth_getCode", [impl, "latest"], `${c.name} ${which} code`)).toLowerCase();
  if (code.length <= 4) throw new Error(`FAILED ${c.name} ${which}: no bytecode at impl ${impl}`);
  out.size = String((code.length - 2) / 2);
  const sel = (s: string) => code.includes(ethers.id(s).slice(2, 10));
  const str = (s: string) => code.includes(hexStr(s));

  if (which === "token") {
    // confiscate capability — three independent signals
    const a = sel("confiscate(address,uint256)"), b = str("Depository wallet not set") || str("Confiscation wallet not set"), d = sel("initializeV4()");
    out.confiscate = a && (b || d) ? "YES" : a || b || d ? `partial(${[a && "sel", b && "str", d && "v4init"].filter(Boolean).join("+")})` : "no";
    out.v3 = sel("defaultAdmin()") ? "v3+" : sel("admin()") ? "v2/v3?" : "pre-v3";
    out.depository = sel("depositoryWallet()") ? "has" : "no";
    out.confWallet = sel("confiscateWallet()") || sel("confiscationWallet()") ? "has" : "no";
  } else {
    const a = str("Confiscate must be single-tier"), b = str("amount below target balance");
    out.confiscate = a && b ? "YES" : a || b ? "partial" : "no";
    out.v3 = sel("defaultAdmin()") ? "v3+" : "pre-v3";
    out.gapless = code.includes(ethers.id("TronUUPSUnauthorizedCallContext()").slice(2, 10)) ? "TronUUPS(TRAP)" : "immutable";
  }
  return out;
}

async function main() {
  const { ethers } = hre;
  const rows: Array<Record<string, string>> = [];
  for (const c of CHAINS) {
    for (const which of ["token", "ctrl", "ctrlOld"] as const) {
      const proxy = c[which];
      if (!proxy) continue;
      const label = which === "token" ? "Token" : which === "ctrl" ? "Controller" : "Controller(OLD)";
      try {
        const r = await classify(c, which, proxy);
        rows.push({ chain: c.name, net: c.net, kind: c.kind, what: label, proxy, ...r });
        console.log(`${c.name}/${label}: ok`);
      } catch (e: any) {
        rows.push({ chain: c.name, net: c.net, kind: c.kind, what: label, proxy, error: e.message });
        console.log(`${c.name}/${label}: ${e.message}`);
      }
    }
  }
  const fs = require("fs");
  fs.writeFileSync("/tmp/idrp-status.json", JSON.stringify(rows, null, 2));
  console.log(`\nwrote /tmp/idrp-status.json (${rows.length} rows)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

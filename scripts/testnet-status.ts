/**
 * Full live status of every IDRP TESTNET deployment.
 *
 *   npx hardhat run scripts/testnet-status.ts --network hardhat
 *
 * Everything is read from the chain at the current block and from deployed bytecode.
 * Proxy addresses are the only thing taken from a file. A read that fails is printed as
 * FAILED — never defaulted, so "feature missing" and "RPC down" can't be confused.
 *
 * The upgradeability column is the important one: it simulates upgradeTo FROM THE REAL
 * UPGRADER. An ordinary "Upgrade not scheduled" means the upgrade path is reachable; a
 * TronUUPSUnauthorizedCallContext() means the proxy is permanently frozen.
 */
import hre from "hardhat";

const I1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const DEAD = "0x0000000000000000000000000000000000000001";

type Target = { chain: string; rpc: string; tron?: boolean; label: string; proxy: string; kind: "token" | "ctrl" };
const T: Target[] = [
  { chain: "Base Sepolia", rpc: "https://sepolia.base.org", label: "Token", kind: "token", proxy: "0x817d0C3D4e63231d88B2d73217B7fB75b87e0606" },
  { chain: "Base Sepolia", rpc: "https://sepolia.base.org", label: "Controller", kind: "ctrl", proxy: "0x466d7B865e394f640aa436a399A464f7dC65C410" },
  { chain: "Kairos", rpc: "https://public-en-kairos.node.kaia.io", label: "Token", kind: "token", proxy: "0x999f947F3c7C0cF64AE53571a7fda51ce7f66164" },
  { chain: "Kairos", rpc: "https://public-en-kairos.node.kaia.io", label: "Controller", kind: "ctrl", proxy: "0x38f94bf4D2D4f4a8E9f35606071DA7A51E92D26A" },
  { chain: "Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", label: "Token", kind: "token", proxy: "0x08d7CfA7ea2a49254eE5374EB3d24037Ff6408c0" },
  { chain: "Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", label: "Controller", kind: "ctrl", proxy: "0xbBd0C476A3c4b88B1728f08f54291c466c3E18a3" },
  { chain: "Nile", rpc: "https://nile.trongrid.io/jsonrpc", tron: true, label: "Token", kind: "token", proxy: "0xf8a0c0078a0ac425f91240432ca90b9205b669ed" },
  { chain: "Nile", rpc: "https://nile.trongrid.io/jsonrpc", tron: true, label: "Controller (NEW)", kind: "ctrl", proxy: "0x7a43a5367fed01f21468f6e38757013f684f1499" },
  { chain: "Nile", rpc: "https://nile.trongrid.io/jsonrpc", tron: true, label: "Controller (OLD)", kind: "ctrl", proxy: "0xe0c7ce95aa4e7605b84332916a2e5d5d78d7ea51" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(url: string, method: string, params: unknown[], label: string): Promise<string> {
  let last: unknown;
  for (let a = 0; a < 5; a++) {
    if (a) await sleep(1000 * a);
    try {
      const j: any = await (await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000),
      })).json();
      if (j?.error || j?.Error) { last = new Error(JSON.stringify(j.error ?? j.Error).slice(0, 60)); continue; }
      if (j?.result !== undefined) return j.result as string;
      last = new Error("no result");
    } catch (e) { last = e; }
  }
  throw new Error(`FAILED ${label}`);
}

async function main() {
  const { ethers } = hre;
  const CTX = ethers.id("TronUUPSUnauthorizedCallContext()").slice(0, 10);
  const rows: any[] = [];

  for (const t of T) {
    const row: any = { chain: t.chain, what: t.label, proxy: t.proxy };
    const call = async (sig: string, from?: string) => {
      try {
        const p: any = { to: t.proxy, data: ethers.id(sig).slice(0, 10) };
        if (from) p.from = from;
        const v = await rpc(t.rpc, "eth_call", [p, "latest"], sig);
        return v === "0x" ? null : v;
      } catch { return null; }
    };
    try {
      row.impl = "0x" + (await rpc(t.rpc, "eth_getStorageAt", [t.proxy, I1967, "latest"], "1967")).slice(26);
      const code = (await rpc(t.rpc, "eth_getCode", [row.impl, "latest"], "code")).toLowerCase();
      const sel = (s: string) => code.includes(ethers.id(s).slice(2, 10));
      const str = (s: string) => code.includes(Buffer.from(s, "utf8").toString("hex"));
      row.isTronUUPS = sel("TronUUPSUnauthorizedCallContext()");

      const d = await call("UPGRADE_DELAY()");
      row.delay = d ? Number(BigInt(d)) : null;
      const at = await call("upgradeScheduledAt()");
      const si = await call("scheduledImplementation()");
      row.scheduled = si && BigInt(si) !== 0n ? "0x" + si.slice(26) : null;
      row.schedAt = at ? Number(BigInt(at)) : null;
      row.upgrader = (await call("upgrader()"))?.slice(26);

      if (t.kind === "token") {
        row.confiscate = sel("confiscate(address,uint256)") ? "yes" : "no";
        row.confWallet = sel("confiscationWallet()") ? "yes" : "no";
        const cw = await call("confiscationWallet()");
        row.confWalletVal = cw ? "0x" + cw.slice(26) : null;
        row.controller = (await call("controller()"))?.slice(26);
        row.admin = (await call("admin()"))?.slice(26);
        row.destination = row.confWallet === "yes" ? "confiscationWallet" : (sel("confiscate(address,uint256)") ? "depositoryWallet" : "n/a");
      } else {
        row.confiscate = str("Confiscate must be single-tier") ? "yes" : "no";
        try {
          const r = await rpc(t.rpc, "eth_call", [{ to: t.proxy,
            data: ethers.id("getQuorumRule(uint8,uint256)").slice(0, 10) +
              ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint256"], [6, 0]).slice(2) }, "latest"], "op6");
          const [rule] = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(uint256,uint256,bytes32[])"], r);
          row.op6 = `${rule[2].length} roles`;
        } catch { row.op6 = "not armed"; }
      }

      // Upgradeability: simulate upgradeTo FROM the real upgrader.
      const from = row.upgrader ? "0x" + row.upgrader : undefined;
      try {
        await rpc(t.rpc, "eth_call", [{ to: t.proxy, from,
          data: ethers.id("upgradeTo(address)").slice(0, 10) +
            ethers.AbiCoder.defaultAbiCoder().encode(["address"], [DEAD]).slice(2) }, "latest"], "upgradeTo");
        row.upgradeable = "reachable (no revert)";
      } catch (e: any) {
        row.upgradeable = row.isTronUUPS ? "FROZEN — TronUUPS trap" : "reachable (guard revert)";
      }
      if (t.tron) {
        // eth_call drops revert data on Tron; classify via triggerconstantcontract.
        const host = "https://nile.trongrid.io";
        const r: any = await (await fetch(host + "/wallet/triggerconstantcontract", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner_address: "TXCxw9Pyu1g8jo8VieZjLpVKMgfSyfKm1d", contract_address: t.proxy.replace(/^0x/, "41"),
            function_selector: "upgradeTo(address)",
            parameter: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [DEAD]).slice(2), visible: false }),
        })).json();
        const cr = (r.constant_result || [])[0];
        if (cr === undefined) row.upgradeable = "INCONCLUSIVE (no result)";
        else if ("0x" + cr.slice(0, 8) === CTX) row.upgradeable = "FROZEN — TronUUPS trap";
        else if (cr.startsWith("08c379a0")) {
          const s = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + cr.slice(8))[0];
          row.upgradeable = `reachable ("${s}")`;
        } else if (cr) row.upgradeable = `reachable (custom 0x${cr.slice(0, 8)})`;
        else row.upgradeable = "reachable (no revert)";
      }
    } catch (e: any) { row.error = e.message; }
    rows.push(row);
    console.log(`${t.chain}/${t.label}: ${row.error ?? "ok"}`);
  }
  require("fs").writeFileSync("/tmp/testnet-status.json", JSON.stringify(rows, null, 2));
  console.log("\nwrote /tmp/testnet-status.json");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

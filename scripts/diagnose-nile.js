// scripts/diagnose-nile.js
const { ethers, deployments } = require("hardhat");

async function main() {
  const proxy = (await deployments.get("IDRP")).address;
  const impl  = (await deployments.get("IDRP_Implementation")).address;
  const idrp = await ethers.getContractAt("IDRP", proxy);

  // Convert hex → T-format
  const crypto = require("crypto");
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const enc58 = (b) => { let n = BigInt("0x"+b.toString("hex")), s=""; while (n>0n) { s=A[Number(n%58n)]+s; n/=58n; } for (const x of b) if (x===0) s="1"+s; else break; return s; };
  const toT = (h) => { const buf = Buffer.from("41"+h.replace(/^0x/,"").toLowerCase(),"hex"); return enc58(Buffer.concat([buf, sha(sha(buf)).slice(0,4)])); };

  console.log("=== Addresses ===");
  console.log("Proxy hex:", proxy);
  console.log("Proxy T  :", toT(proxy));
  console.log("Impl hex :", impl);
  console.log("Impl T   :", toT(impl));

  console.log("\n=== TRC20 functions ===");
  console.log("name        :", await idrp.name());
  console.log("symbol      :", await idrp.symbol());
  console.log("decimals    :", await idrp.decimals());
  console.log("totalSupply :", (await idrp.totalSupply()).toString());

  console.log("\n=== Tronscan API check ===");
  const proxyT = toT(proxy);
  const url = `https://nileapi.tronscan.org/api/token_trc20?contract=${proxyT}`;
  console.log("URL:", url);
  const res = await fetch(url);
  const json = await res.json();
  console.log("Indexed as TRC20:", (json.data && json.data.length > 0) ? "✅ YES" : "❌ NO");
  if (json.data && json.data[0]) {
    console.log("  name    :", json.data[0].name);
    console.log("  symbol  :", json.data[0].symbol);
    console.log("  decimals:", json.data[0].decimals);
  }
}

main().catch(console.error);
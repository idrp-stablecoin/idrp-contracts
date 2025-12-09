import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const TronWeb = require("tronweb");

async function main() {
  const tronWeb = new TronWeb({
    fullHost: "https://api.shasta.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    privateKey: process.env.PRIVATE_KEY_SHASTA,
  });

  // IDRPOFTUpgradeable on TRON Shasta
  const oappAddr = "TGs6gVP1W8m8kqBcfZNjPnmtPPAWdhdGS2"; // Base58
  const eidBaseSepolia = 40245;
  const peerBytes32 =
    "0x000000000000000000000000dbcc4d7c7790bcbc755d874d1429176fa35ac10a"; // Base adapter on Base Sepolia

  // Load OApp ABI
  const artifactPath = path.join(
    __dirname,
    "../../../artifacts/contracts/oft/IDRPOFTUpgradeable.sol/IDRPOFTUpgradeable.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const oapp = await tronWeb.contract(artifact.abi, oappAddr);

  console.log("Step 1: Setting peer...");
  console.log(`  OApp: ${oappAddr}`);
  console.log(`  Destination EID: ${eidBaseSepolia}`);
  console.log(`  Peer: ${peerBytes32}`);

  const tx = await oapp.setPeer(eidBaseSepolia, peerBytes32).send({
    feeLimit: 150_000_000,
  });

  console.log("✓ setPeer submitted:", tx);
  console.log(`  View: https://shasta.tronscan.org/#/transaction/${tx}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

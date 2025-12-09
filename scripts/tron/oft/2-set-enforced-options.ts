import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { EndpointId } from "@layerzerolabs/lz-definitions";

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

  // Load OApp ABI
  const artifactPath = path.join(
    __dirname,
    "../../../artifacts/contracts/oft/IDRPOFTUpgradeable.sol/IDRPOFTUpgradeable.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const oapp = await tronWeb.contract(artifact.abi, oappAddr);

  // Set enforced options for Base Sepolia
  const enforcedOptions = [
    // BROADCAST message type (msgType 0)
    [
      EndpointId.BASESEP_V2_TESTNET,
      0,
      Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex(),
    ],
    // SEND message type (msgType 1)
    [
      EndpointId.BASESEP_V2_TESTNET,
      1,
      Options.newOptions().addExecutorLzReceiveOption(80000, 0).toHex(),
    ],
  ];

  console.log("Step 2: Setting enforced options...");
  console.log(`  OApp: ${oappAddr}`);
  console.log(`  Options:`, enforcedOptions);

  const tx = await oapp.setEnforcedOptions(enforcedOptions).send({
    feeLimit: 150_000_000,
  });

  console.log("✓ setEnforcedOptions submitted:", tx);
  console.log(`  View: https://shasta.tronscan.org/#/transaction/${tx}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

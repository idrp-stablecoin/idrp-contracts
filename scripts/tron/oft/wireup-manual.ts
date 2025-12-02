import { EndpointId } from "@layerzerolabs/lz-definitions";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

// Load environment variables
dotenv.config();

// Use require instead of import for TronWeb
const TronWeb = require("tronweb");

async function main() {
  const eidBaseSepolia = EndpointId.BASESEP_V2_TESTNET;
  const peerBytes32 =
    "0x000000000000000000000000dbcc4d7c7790bcbc755d874d1429176fa35ac10a"; // adapter addr padded

  // IDRPOFTUpgradeable on TRON
  const tronOftAddr = "TGs6gVP1W8m8kqBcfZNjPnmtPPAWdhdGS2"; // Base58 address (proxy)
  console.log("Using tronOftAddr:", tronOftAddr);

  // Initialize TronWeb
  const tronWeb = new TronWeb({
    fullHost: "https://api.shasta.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    privateKey: process.env.PRIVATE_KEY_SHASTA,
  });
  console.log(
    "TronWeb initialized with address:",
    tronWeb.defaultAddress.base58
  );

  // Load the implementation ABI
  const artifactPath = path.join(
    __dirname,
    "../../../artifacts/contracts/oft/IDRPOFTUpgradeable.sol/IDRPOFTUpgradeable.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // Get contract instance with implementation ABI
  const oft = await tronWeb.contract(artifact.abi, tronOftAddr);
  console.log("Contract instance obtained with implementation ABI");

  // Set peer
  console.log("Setting peer...");
  const tx = await oft.setPeer(eidBaseSepolia, peerBytes32).send({
    feeLimit: 1000000000, // 1000 TRX
  });
  console.log("setPeer submitted:", tx);

  // Wait for confirmation
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Set enforced options
  const enforcedOptions = [
    // BROADCAST message type (custom)
    [
      EndpointId.BASESEP_V2_TESTNET,
      0,
      Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex(),
    ],
    // SEND message type
    [
      EndpointId.BASESEP_V2_TESTNET,
      1,
      Options.newOptions().addExecutorLzReceiveOption(80000, 0).toHex(),
    ],
  ];

  console.log("Setting enforced options...");
  const tx2 = await oft.setEnforcedOptions(enforcedOptions).send({
    feeLimit: 1000000000, // 1000 TRX
  });
  console.log("setEnforcedOptions submitted:", tx2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import * as dotenv from "dotenv";
import { vars } from "hardhat/config";

dotenv.config();

const IDRP_DEPLOYER_PRIVATE_KEY = vars.get("IDRP_DEPLOYER_PRIVATE_KEY");

const TronWeb = require("tronweb");

async function main() {
  const tronWeb = new TronWeb({
    fullHost: "https://api.shasta.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    // privateKey: process.env.PRIVATE_KEY_SHASTA,
    privateKey: IDRP_DEPLOYER_PRIVATE_KEY,
  });

  // Endpoint on TRON Shasta
  const endpointAddr = "TCT5FvMTuUCspdY689LbKbUThCwBVUw4tM"; // 0x1b356f3030CE0c1eF9D3e1E250Bf0BB11D81b2d1
  const oappAddr = "TGs6gVP1W8m8kqBcfZNjPnmtPPAWdhdGS2"; // 0x4bA11be2056CCa41Ee31b9b6239a883dcBA8B293
  const sendLibAddr = "TRvKXqDiPd4y1RCjLyadYeEoPrcyg9CERs"; // 0xaef63752785Ad2104cea1aa42b69b46f2530312F
  const eidBaseSepolia = 40245;

  // Executor config (configType 1)
  const executorConfig =
    "0x0000000000000000000000000000000000000000000000000000000000002710000000000000000000000000d9f0144ac7ced407a12de2649b560b0a68a59a3d";

  // ULN config (configType 2)
  const ulnConfig =
    "0x" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "000000000000000000000000c6b1a264d9bb30a8d19575b0bb3ba525a3a6fc93" +
    "0000000000000000000000000000000000000000000000000000000000000000";

  const endpointAbi = [
    {
      name: "setConfig",
      type: "Function",
      inputs: [
        { type: "address", name: "oapp" },
        { type: "address", name: "lib" },
        {
          type: "tuple[]",
          name: "params",
          components: [
            { type: "uint32", name: "eid" },
            { type: "uint256", name: "configType" },
            { type: "bytes", name: "config" },
          ],
        },
      ],
    },
  ];

  const endpoint = await tronWeb.contract(endpointAbi, endpointAddr);

  // Build params for SendULN302
  const params = [
    [eidBaseSepolia, 1, executorConfig], // configType 1 = executor
    [eidBaseSepolia, 2, ulnConfig], // configType 2 = ULN
  ];

  console.log("Step 5a: Setting config for SendULN302...");
  console.log(`  Endpoint: ${endpointAddr}`);
  console.log(`  OApp: ${oappAddr}`);
  console.log(`  Library: ${sendLibAddr} (SendULN302)`);
  console.log(`  Params:`, params);

  const tx = await endpoint
    .setConfig(oappAddr, sendLibAddr, params)
    .send({ feeLimit: 250_000_000 });

  console.log("✓ setConfig (SendULN302) submitted:", tx);
  console.log(`  View: https://shasta.tronscan.org/#/transaction/${tx}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

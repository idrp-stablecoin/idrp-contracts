import * as dotenv from "dotenv";

dotenv.config();

const TronWeb = require("tronweb");

async function main() {
  const tronWeb = new TronWeb({
    fullHost: "https://api.shasta.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    privateKey: process.env.PRIVATE_KEY_SHASTA,
  });

  // Endpoint on TRON Shasta
  const endpointAddr = "TCT5FvMTuUCspdY689LbKbUThCwBVUw4tM"; // 0x1b356f3030CE0c1eF9D3e1E250Bf0BB11D81b2d1
  const oappAddr = "TGs6gVP1W8m8kqBcfZNjPnmtPPAWdhdGS2"; // 0x4bA11be2056CCa41Ee31b9b6239a883dcBA8B293
  const sendLibAddr = "TRvKXqDiPd4y1RCjLyadYeEoPrcyg9CERs"; // 0xaef63752785Ad2104cea1aa42b69b46f2530312F
  const eidBaseSepolia = 40245;
  // const eidBaseSepolia = 40420; // for tron shasta

  const endpointAbi = [
    {
      name: "setSendLibrary",
      type: "Function",
      inputs: [
        { type: "address", name: "oapp" },
        { type: "uint32", name: "eid" },
        { type: "address", name: "sendLib" },
      ],
    },
    {
      name: "getSendLibrary",
      type: "Function",
      inputs: [
        { type: "address", name: "_sender" },
        { type: "uint32", name: "_dstEid" },
      ],
      outputs: [{ type: "address", name: "lib" }],
      stateMutability: "view",
    },
  ];

  const endpoint = await tronWeb.contract(endpointAbi, endpointAddr);

  console.log("Step 3: Setting send library...");
  console.log(`  Endpoint: ${endpointAddr}`);
  console.log(`  OApp: ${oappAddr}`);
  console.log(`  Destination EID: ${eidBaseSepolia}`);
  console.log(`  Send Library: ${sendLibAddr}`);

  console.log("  Verifying before setSendLibrary...");
  let currentLib = await endpoint
    .getSendLibrary(oappAddr, eidBaseSepolia)
    .call();
  console.log(`    Current send library: ${currentLib}`);

  // const tx = await endpoint
  //   .setSendLibrary(oappAddr, eidBaseSepolia, sendLibAddr)
  //   .send({ feeLimit: 200_000_000 });

  // console.log("✓ setSendLibrary submitted:", tx);
  // console.log(`  View: https://shasta.tronscan.org/#/transaction/${tx}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

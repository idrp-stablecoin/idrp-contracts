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
  const receiveLibAddr = "TN2KMvPCcmCq9vVzGUcrzrbwXLy5f3qZeZ"; // 0x843810EB9f002E940870a95B366cc59E623bF5f1
  const eidBaseSepolia = 40245;
  // const eidBaseSepolia = 40420; // for tron shasta
  const gracePeriod = 0;

  const endpointAbi = [
    {
      name: "setReceiveLibrary",
      type: "Function",
      inputs: [
        { type: "address", name: "oapp" },
        { type: "uint32", name: "eid" },
        { type: "address", name: "receiveLib" },
        { type: "uint256", name: "gracePeriod" },
      ],
    },
    {
      name: "getReceiveLibrary",
      type: "Function",
      inputs: [
        { type: "address", name: "_sender" },
        { type: "uint32", name: "_dstEid" },
      ],
      outputs: [
        { type: "address", name: "lib" },
        { type: "bool", name: "isDefault" },
      ],
      stateMutability: "view",
    },
    {
      name: "getRegisteredLibraries",
      type: "Function",
      outputs: [{ type: "address[]", name: "libs" }],
      stateMutability: "view",
    },
  ];

  const endpoint = await tronWeb.contract(endpointAbi, endpointAddr);

  console.log("Step 4: Setting receive library...");
  console.log(`  Endpoint: ${endpointAddr}`);
  console.log(`  OApp: ${oappAddr}`);
  console.log(`  Destination EID: ${eidBaseSepolia}`);
  console.log(`  Receive Library: ${receiveLibAddr}`);
  console.log(`  Grace Period: ${gracePeriod}`);

  console.log("  Verifying before setReceiveLibrary...");
  let currentLib = await endpoint
    .getReceiveLibrary(oappAddr, eidBaseSepolia)
    .call();
  console.log(`    Current receive library: ${currentLib}`);
  let registeredLibs = await endpoint.getRegisteredLibraries().call();
  console.log(`    Registered libraries: ${registeredLibs}`);

  const tx = await endpoint
    .setReceiveLibrary(oappAddr, eidBaseSepolia, receiveLibAddr, gracePeriod)
    .send({ feeLimit: 200_000_000 });

  console.log("✓ setReceiveLibrary submitted:", tx);
  console.log(`  View: https://shasta.tronscan.org/#/transaction/${tx}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

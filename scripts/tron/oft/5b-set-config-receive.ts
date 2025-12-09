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
  const endpointAddr = "TYyJ1TQ2XrYkZN2rP2mBpRzCqxfZQye1qP"; // 0x1b356f3030CE0c1eF9D3e1E250Bf0BB11D81b2d1
  const oappAddr = "TGs6gVP1W8m8kqBcfZNjPnmtPPAWdhdGS2"; // 0x4bA11be2056CCa41Ee31b9b6239a883dcBA8B293
  const receiveLibAddr = "TUKtdBGu4P2GCqUpXgajkRrzL9N3LWMW4H"; // 0x843810EB9f002E940870a95B366cc59E623bF5f1
  const eidBaseSepolia = 40245;

  // ULN config (configType 2) - same as send
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

  // Build params for ReceiveULN302 - only ULN config (no executor)
  const params = [[eidBaseSepolia, 2, ulnConfig]]; // configType 2 = ULN

  console.log("Step 5b: Setting config for ReceiveULN302...");
  console.log(`  Endpoint: ${endpointAddr}`);
  console.log(`  OApp: ${oappAddr}`);
  console.log(`  Library: ${receiveLibAddr} (ReceiveULN302)`);
  console.log(`  Params:`, params);

  const tx = await endpoint
    .setConfig(oappAddr, receiveLibAddr, params)
    .send({ feeLimit: 250_000_000 });

  console.log("✓ setConfig (ReceiveULN302) submitted:", tx);
  console.log(`  View: https://shasta.tronscan.org/#/transaction/${tx}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

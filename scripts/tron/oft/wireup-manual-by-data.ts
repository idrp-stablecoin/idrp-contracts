import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { AbiCoder, Interface } from "ethers/lib/utils";
import { de } from "@layerzerolabs/lz-evm-sdk-v2/dist/index-DKWcH5XL";

dotenv.config();

// TRON
const TronWeb = require("tronweb");

type WiringItem = {
  point: { eid: number; address: string };
  data: string; // full calldata
  description?: string;
  tx?: string; // injected tx hash when sent
};

// Function selectors (first 4 bytes)
const SIG_SET_CONFIG = "0x6dbd9f90";
const SIG_SET_SEND_LIBRARY = "0x9535ff30";
const SIG_SET_RECEIVE_LIBRARY = "0x6a14d715";

function slice(data: string, startBytes: number, lengthBytes?: number) {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const start = startBytes * 2;
  const end = lengthBytes ? start + lengthBytes * 2 : undefined;
  return "0x" + hex.slice(start, end);
}

function readAddress32(data: string, offsetBytes: number) {
  const word = slice(data, offsetBytes, 32).replace(/^0x/, "");
  return "0x" + word.slice(-40);
}

function readUint32(data: string, offsetBytes: number) {
  return Number(BigInt(slice(data, offsetBytes, 32)));
}

function readBytes(data: string, offsetBytes: number) {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const ptr = Number(BigInt(slice(data, offsetBytes, 32)));
  const len = Number(BigInt("0x" + hex.slice(ptr * 2, ptr * 2 + 64)));
  const start = ptr + 32;
  return "0x" + hex.slice(start * 2, start * 2 + len * 2);
}

function isHex0x(addr: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
function isHex41(addr: string) {
  return /^41[0-9a-fA-F]{40}$/.test(addr);
}
function isBase58(addr: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{34}$/.test(addr);
}

function toTronHex(tronWeb: any, addr: string) {
  if (isHex41(addr)) return addr;
  if (isHex0x(addr))
    return tronWeb.address.toHex(tronWeb.address.fromHex(addr));
  if (isBase58(addr)) return tronWeb.address.toHex(addr);
  throw new Error(`Unsupported address format: ${addr}`);
}

function toBase58(tronWeb: any, addr: string) {
  if (isBase58(addr)) return addr;
  if (isHex41(addr)) return tronWeb.address.fromHex(addr);
  if (isHex0x(addr)) return tronWeb.address.fromHex(addr);
  throw new Error(`Unsupported address format: ${addr}`);
}

async function submitOnTron(item: WiringItem) {
  console.log("wiringItem:", item);
  const eid: number = item.point.eid;
  const address: string = item.point.address;
  const calldata: string = item.data;

  const tronWeb = new TronWeb({
    fullHost: "https://api.shasta.trongrid.io",
    headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
    privateKey: process.env.PRIVATE_KEY_SHASTA,
  });
  console.log(
    `Submitting wiring txn on TRON for EID ${eid} address ${address}`
  );

  const abi = ["function setConfig(address, address, (uint32,uint32,bytes)[])"];
  const iface = new Interface(abi);
  const decodedCalldata = iface.parseTransaction({ data: calldata });
  const selector = decodedCalldata.sighash;
  const selectorSignature = decodedCalldata.signature;
  console.log("decodedCalldata:", {
    decodedCalldata,
    selector,
    name: decodedCalldata.name,
    args: decodedCalldata.args,
    argsT: decodedCalldata.args.map((a) =>
      typeof a === "object" ? a.toString() : typeof a
    ),
  });

  const reconstructedCalldata = [
    { type: "address", value: toBase58(tronWeb, decodedCalldata.args[0]) },
    { type: "address", value: toBase58(tronWeb, decodedCalldata.args[1]) },
    {
      type: "(uint32,uint32,bytes)[]",
      // we expect merged of the tuple item, like: [0, 1, bytesdata, 0, 2, bytesdata, ...]
      // in tron we must like that
      value: [...decodedCalldata.args[2]],
    },
  ];
  console.log("reconstructedCalldata:", {
    vvv: [...decodedCalldata.args[2]],
    reconstructedCalldata,
    reconstructedCalldataT: reconstructedCalldata.map((a) =>
      typeof a.value === "object"
        ? a.value.map((b) =>
            typeof b.value === "object"
              ? JSON.stringify(b.value, null, 2)
              : b.value
          )
        : a.value
    ),
  });

  // send raw data
  const tx = await tronWeb.transactionBuilder.triggerSmartContract(
    toBase58(tronWeb, address),
    selectorSignature,
    {
      feeLimit: 100_000_000,
    },
    reconstructedCalldata
  );

  const signedTx = await tronWeb.trx.sign(tx.transaction);
  const broadcast = await tronWeb.trx.sendRawTransaction(signedTx);

  console.log(broadcast);

  if (broadcast.transaction.txID) {
    return broadcast.transaction.txID;
  }

  return "";
}

function loadItems(jsonPath: string): WiringItem[] {
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function saveItems(jsonPath: string, items: WiringItem[]) {
  fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2));
}

async function main() {
  const jsonPath = path.join(__dirname, "./data/wiring-txns.json");
  const items: WiringItem[] = loadItems(jsonPath);

  const targetEid = Number(process.env.WIRE_TARGET_EID || "40420"); // 40420 TRON_V2_TESTNET

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.point.eid !== targetEid) continue;

    // Skip if already sent
    if (item.tx && item.tx.length > 0) {
      console.log(`Skip: already has tx ${item.tx}`);
      continue;
    }

    try {
      const tx = await submitOnTron(item);
      if (tx) {
        console.log("Sent. tx:", tx);
        // Inject tx back into JSON
        items[i] = { ...item, tx };
        saveItems(jsonPath, items);
      } else {
        console.log("No tx produced for item selector");
      }
    } catch (e) {
      console.error("Send failed:", e);
      // leave unsent for retry
    }
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

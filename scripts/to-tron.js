// scripts/to-tron.js
const TronWeb = require("tronweb");
const tronWeb = new TronWeb({ fullHost: "https://api.shasta.trongrid.io" });

const PROXY_HEX = "0x6717fbc0a2300c878A38E9D078986D583Bc403Ca";
const IMPL_HEX  = "0x0D5437EDeA002A053D5638aFfb05B2af5B175286";

const toTron = (hex) => tronWeb.address.fromHex("41" + hex.slice(2).toLowerCase());

console.log("Proxy (T-format)         :", toTron(PROXY_HEX));
console.log("Implementation (T-format):", toTron(IMPL_HEX));
console.log();
console.log("Tronscan Proxy URL         :", "https://shasta.tronscan.org/#/contract/" + toTron(PROXY_HEX));
console.log("Tronscan Implementation URL:", "https://shasta.tronscan.org/#/contract/" + toTron(IMPL_HEX));
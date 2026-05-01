// scripts/diagnose.js  (CommonJS — sesuai package.json default)
const { deployments, ethers } = require("hardhat");

async function main() {
  const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

  let proxyDep, implDep;
  try {
    proxyDep = await deployments.get("IDRP");
    implDep  = await deployments.get("IDRP_Implementation");
  } catch (e) {
    console.error("[X] Deployment files tidak ditemukan. Run: npx hardhat deploy --network shasta --tags IDRP");
    return;
  }

  console.log("Proxy address      :", proxyDep.address);
  console.log("Implementation addr:", implDep.address);

  const proxyCode = await ethers.provider.getCode(proxyDep.address);
  const implCode  = await ethers.provider.getCode(implDep.address);
  console.log("Proxy has code     :", proxyCode !== "0x");
  console.log("Impl  has code     :", implCode  !== "0x");

  const raw = await ethers.provider.getStorage(proxyDep.address, SLOT);
  const implFromSlot = "0x" + raw.slice(-40);
  console.log("Slot points to     :", implFromSlot);

  const matches = implFromSlot.toLowerCase() === implDep.address.toLowerCase().replace(/^0x/, "0x");
  console.log("Slot matches impl  :", matches ? "✓ YES" : "✗ NO — proxy not initialized correctly");
}

main().catch((e) => { console.error(e); process.exit(1); });
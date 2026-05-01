// scripts/check-trc20.js
const { ethers, deployments } = require("hardhat");

async function main() {
  const proxy = (await deployments.get("IDRP")).address;
  const idrp = await ethers.getContractAt("IDRP", proxy);
  const [signer] = await ethers.getSigners();

  console.log("Address    :", proxy);
  console.log();

  try {
    console.log("name()       :", await idrp.name());
    console.log("symbol()     :", await idrp.symbol());
    console.log("decimals()   :", await idrp.decimals());
    console.log("totalSupply():", (await idrp.totalSupply()).toString());
    console.log("balanceOf()  :", (await idrp.balanceOf(signer.address)).toString());
  } catch (e) {
    console.error("ERROR:", e.message);
  }
}

main().catch(console.error);
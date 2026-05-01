// scripts/heat-index.js
const { ethers, deployments } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  const proxy = (await deployments.get("IDRP")).address;
  const idrp = await ethers.getContractAt("IDRP", proxy);

  console.log("Doing 5 transfers to trigger TRC20 indexing...\n");

  for (let i = 1; i <= 5; i++) {
    const dummy = `0x${i.toString(16).padStart(40, "0")}`;
    console.log(`[${i}/5] Transfer 0.001 IDRP → ${dummy}`);
    const tx = await idrp.transfer(dummy, ethers.parseUnits("0.001", 6));
    await tx.wait();
    console.log(`       ✓ tx: ${tx.hash}`);
  }

  console.log("\nDone. Wait 3-10 minutes, then re-check Tronscan API.");
}

main().catch(console.error);
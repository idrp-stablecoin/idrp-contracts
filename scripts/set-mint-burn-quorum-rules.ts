import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import hre from "hardhat";
import mintBurnQuorumRules from "../test/utils/rules.mint.burn.v2.json";
import { delay } from "./utils/misc";

async function main() {
  const networkId = hre.network.config.chainId ?? 8545;
  const signers = await ethers.getSigners();
  const admin = signers[1];

  console.log("Admin address:", await admin.getAddress());
  console.log("Has sendTransaction:", typeof admin.sendTransaction);

  const deployments = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployment/chain-" + networkId + ".json"),
      "utf-8",
    ),
  );

  // IDRP token
  const idrp = await ethers.getContractAt("IDRP", deployments["IDRP"]);
  console.log("IDRP token address:", await idrp.getAddress());

  // IDRPController
  const controller = await ethers.getContractAt(
    "IDRPController",
    deployments["IDRPController"],
  );
  console.log("IDRPController address:", await controller.getAddress());

  // Set mint quorum rules
  console.log("Setting mint quorum rules...");
  await controller.connect(admin).setQuorumRules(
    0, // OperationType.Mint
    mintBurnQuorumRules,
  );

  console.log("Mint quorum rules set successfully!");

  console.log("Waiting for 2 seconds before setting burn quorum rules...");
  await delay(2000);

  // Set burn quorum rules
  console.log("Setting burn quorum rules...");
  await controller.connect(admin).setQuorumRules(
    1, // OperationType.Burn
    mintBurnQuorumRules,
  );

  console.log("Burn quorum rules set successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

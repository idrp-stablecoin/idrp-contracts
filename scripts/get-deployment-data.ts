import { ethers } from "hardhat";
import { ADMIN_ADDRESS } from "./utils/constants";

async function main() {
  const IDRP = await ethers.getContractFactory("IDRP");
  const iface = IDRP.interface;

  const data = iface.encodeFunctionData("initialize", [ADMIN_ADDRESS]);

  console.log(data);
}

main();

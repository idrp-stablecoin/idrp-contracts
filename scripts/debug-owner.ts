import { ethers, deployments } from "hardhat";
import { vars } from "hardhat/config";

(async () => {
  const all = await deployments.all();

  const controller = await ethers.getContractAt(
    "IDRPController",
    all["IDRPController"].address
  );

  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // hardhat-tron only exposes one signer — derive admin separately
  const adminPk = vars.get("IDRP_ADMIN_PRIVATE_KEY_TRON");
  const adminWallet = new ethers.Wallet(
    adminPk.startsWith("0x") ? adminPk : `0x${adminPk}`
  );

  const onChainOwner = await controller.owner();

  console.log("IDRPController proxy:", await controller.getAddress());
  console.log("signers[0] (deployer):", deployer.address);
  console.log("admin derived from PK:", adminWallet.address);
  console.log("owner() on-chain:     ", onChainOwner);
  console.log("deployer is owner:", onChainOwner.toLowerCase() === deployer.address.toLowerCase());
  console.log("admin is owner:   ", onChainOwner.toLowerCase() === adminWallet.address.toLowerCase());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});


import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import { vars } from "hardhat/config";

enum OperationType {
  Mint,
  Burn,
  Freeze,
  Unfreeze,
  Pause,
  Unpause,
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  console.log("deployer", deployer.address);

  // These addresses should match your accounts on Holesky
  // If you're using different accounts, replace these with your own
  const managerAddress = "0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761";
  const directorAddress = "0x5B2A48685a89458ECbaB3AEC56923e128f441995";
  const commissionerAddress = "0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed";

  console.log("Manager:", managerAddress);
  console.log("Director:", directorAddress);
  console.log("Commissioner:", commissionerAddress);

  // Load contract addresses from deployment file
  const deployments = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployment/chain-17000.json"),
      "utf-8"
    )
  );

  // Connect to deployed contracts
  const idrp = await ethers.getContractAt("IDRP", deployments["IDRP"]);
  console.log("IDRP token address:", await idrp.getAddress());

  const controller = await ethers.getContractAt(
    "IDRPController",
    deployments["IDRPController"]
  );
  console.log("IDRPController address:", await controller.getAddress());

  console.log("nonce", await controller.nonce());

  // Check initial pause state
  const isPaused = await idrp.paused();
  console.log("Current pause state:", isPaused);

  if (isPaused) {
    console.log("Token is already paused. Exiting.");
    return;
  }

  // Create the operation data
  const operation = {
    to: ethers.ZeroAddress,
    operationType: OperationType.Pause,
    amount: 0,
    nonce: await controller.nonce(),
    deadline: Math.floor(Date.now() / 1000) + 3600 * 24 * 30, // 30 days from now
  };

  console.log("Operation:", operation);

  // Domain and types for EIP-712 signature
  const domain = {
    name: "IDRPController",
    version: "1",
    chainId: 17000, // Holesky chain ID
    verifyingContract: await controller.getAddress(),
  };

  const types = {
    Operation: [
      { name: "to", type: "address" },
      { name: "operationType", type: "uint8" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  console.log("Domain:", domain);
  console.log("Types:", types);

  // Get private keys from environment variables
  // Assuming you have these set in your environment or .env file
  const managerPrivateKey = vars.get("MANAGER_PRIVATE_KEY");
  const directorPrivateKey = vars.get("DIRECTOR_PRIVATE_KEY");

  if (!managerPrivateKey || !directorPrivateKey) {
    console.log("ERROR: Missing private keys in environment variables");
    console.log(
      "Set MANAGER_PRIVATE_KEY and DIRECTOR_PRIVATE_KEY in your environment"
    );
    return;
  }

  // Create wallet instances for signers
  const manager = new ethers.Wallet(managerPrivateKey, ethers.provider);
  const director = new ethers.Wallet(directorPrivateKey, ethers.provider);

  console.log("Getting signatures from manager and director...");

  // Sign with manager and director
  const managerSignature = await manager.signTypedData(
    domain,
    types,
    operation
  );
  const directorSignature = await director.signTypedData(
    domain,
    types,
    operation
  );

  console.log("Manager signature:", managerSignature);
  console.log("Director signature:", directorSignature);

  // Execute the pause operation
  console.log("Executing pause operation...");

  // Check if the manager has the required roles
  console.log("Checking manager role...");
  const hasManagerRole = await controller.hasRole(
    ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE")),
    manager.address
  );
  console.log("Manager has MANAGER_ROLE:", hasManagerRole);

  // Execute with deployer who should have admin rights
  //   console.log("Executing with deployer wallet...");
  //   const tx = await controller.connect(deployer).executeOperation(
  const tx = await controller.connect(manager).executeOperation(
    operation.operationType,
    operation.to,
    operation.amount,
    operation.deadline,
    [managerSignature, directorSignature]
    // { gasLimit: 500000 } // Add explicit gas limit
  );

  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("Transaction confirmed");

  // Verify token is now paused
  const newPauseState = await idrp.paused();
  console.log("New pause state:", newPauseState);

  if (newPauseState) {
    console.log("✅ Token successfully paused");
  } else {
    console.log("❌ Failed to pause token");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

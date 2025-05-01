import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import { vars } from "hardhat/config";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  console.log("deployer", deployer.address);

  // These addresses should match your accounts on Holesky
  // If you're using different accounts, replace these with your own
  const officerAddress = "0x99A0AD5DF1651D8812B0b4Ca5102ad060C4DC2d3";
  const managerAddress = "0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761";
  const directorAddress = "0x5B2A48685a89458ECbaB3AEC56923e128f441995";
  const commissionerAddress = "0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed";

  console.log("Officer:", officerAddress);
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

  // Check initial pause state
  const isPaused = await idrp.paused();
  console.log("Current pause state:", isPaused);

  if (!isPaused) {
    console.log("Token is already unpaused. Exiting.");
    return;
  }

  // Create the operation data
  const operation = {
    to: ethers.ZeroAddress,
    operationType: 5, // Unpause operation (index 5 in enum)
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
  const officerPrivateKey = vars.get("OFFICER_PRIVATE_KEY");
  const managerPrivateKey = vars.get("MANAGER_PRIVATE_KEY");
  const directorPrivateKey = vars.get("DIRECTOR_PRIVATE_KEY");
  // const commissionerPrivateKey = process.env.COMMISSIONER_PRIVATE_KEY; // Uncomment if using alternative signature set

  // Choose which signature set to use
  const useOfficerManagerDirector = true; // Set to false to use manager+director+commissioner instead

  if (useOfficerManagerDirector) {
    // Check if we have the required private keys for officer+manager+director combination
    if (!officerPrivateKey || !managerPrivateKey || !directorPrivateKey) {
      console.log("ERROR: Missing private keys in environment variables");
      console.log(
        "Set OFFICER_PRIVATE_KEY, MANAGER_PRIVATE_KEY, and DIRECTOR_PRIVATE_KEY in your environment"
      );
      return;
    }

    // Create wallet instances for signers
    const officer = new ethers.Wallet(officerPrivateKey, ethers.provider);
    const manager = new ethers.Wallet(managerPrivateKey, ethers.provider);
    const director = new ethers.Wallet(directorPrivateKey, ethers.provider);

    console.log("Getting signatures from officer, manager, and director...");

    // Sign with officer, manager, and director
    const officerSignature = await officer.signTypedData(
      domain,
      types,
      operation
    );
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

    console.log("Officer signature:", officerSignature);
    console.log("Manager signature:", managerSignature);
    console.log("Director signature:", directorSignature);

    // Execute the unpause operation
    console.log(
      "Executing unpause operation with officer+manager+director signatures..."
    );
    const tx = await controller.executeOperation(
      operation.operationType,
      operation.to,
      operation.amount,
      operation.deadline,
      [officerSignature, managerSignature, directorSignature]
    );

    console.log("Transaction sent:", tx.hash);
    await tx.wait();
    console.log("Transaction confirmed");
  } else {
    // Alternative signature set: manager+director+commissioner
    if (
      !managerPrivateKey ||
      !directorPrivateKey ||
      !process.env.COMMISSIONER_PRIVATE_KEY
    ) {
      console.log("ERROR: Missing private keys in environment variables");
      console.log(
        "Set MANAGER_PRIVATE_KEY, DIRECTOR_PRIVATE_KEY, and COMMISSIONER_PRIVATE_KEY in your environment"
      );
      return;
    }

    // Create wallet instances for signers
    const manager = new ethers.Wallet(managerPrivateKey, ethers.provider);
    const director = new ethers.Wallet(directorPrivateKey, ethers.provider);
    const commissioner = new ethers.Wallet(
      process.env.COMMISSIONER_PRIVATE_KEY,
      ethers.provider
    );

    console.log(
      "Getting signatures from manager, director, and commissioner..."
    );

    // Sign with manager, director, and commissioner
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
    const commissionerSignature = await commissioner.signTypedData(
      domain,
      types,
      operation
    );

    console.log("Manager signature:", managerSignature);
    console.log("Director signature:", directorSignature);
    console.log("Commissioner signature:", commissionerSignature);

    // Execute the unpause operation
    console.log(
      "Executing unpause operation with manager+director+commissioner signatures..."
    );
    const tx = await controller.executeOperation(
      operation.operationType,
      operation.to,
      operation.amount,
      operation.deadline,
      [managerSignature, directorSignature, commissionerSignature]
    );

    console.log("Transaction sent:", tx.hash);
    await tx.wait();
    console.log("Transaction confirmed");
  }

  // Verify token is now unpaused
  const newPauseState = await idrp.paused();
  console.log("New pause state:", newPauseState);

  if (!newPauseState) {
    console.log("✅ Token successfully unpaused");
  } else {
    console.log("❌ Failed to unpause token");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

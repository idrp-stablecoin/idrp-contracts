import fs from "fs";
import path from "path";
import hre, { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkId = hre.network.config.chainId ?? 8545;
  console.log("Deployer:", deployer.address);

  // Load contract addresses from deployment file
  const deployments = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployment/chain-" + networkId + ".json"),
      "utf-8"
    )
  );

  // Connect to deployed contracts
  const controller = await ethers.getContractAt(
    "IDRPController",
    deployments["IDRPController"]
  );
  console.log("IDRPController address:", await controller.getAddress());

  // Define role constants
  const OFFICER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = ethers.keccak256(
    ethers.toUtf8Bytes("COMMISSIONER_ROLE")
  );

  console.log("Setting up pause quorum rules...");

  // Set quorum rules for Pause (OperationType = 4)
  const pauseRules = [
    {
      minAmount: 0,
      maxAmount: ethers.MaxUint256,
      requiredRoles: [MANAGER_ROLE, DIRECTOR_ROLE],
    },
  ];

  console.log("Pause rule:", pauseRules[0]);

  const pauseTx = await controller.setQuorumRules(4, pauseRules);
  console.log("Setting pause rules, transaction:", pauseTx.hash);
  await pauseTx.wait();
  console.log("Pause rules set successfully");

  // Set quorum rules for Unpause (OperationType = 5)
  const unpauseRules = [
    {
      minAmount: 0,
      maxAmount: ethers.MaxUint256,
      requiredRoles: [
        OFFICER_ROLE,
        MANAGER_ROLE,
        DIRECTOR_ROLE,
        COMMISSIONER_ROLE,
      ],
    },
  ];

  console.log("Unpause rule:", unpauseRules[0]);

  const unpauseTx = await controller.setQuorumRules(5, unpauseRules);
  console.log("Setting unpause rules, transaction:", unpauseTx.hash);
  await unpauseTx.wait();
  console.log("Unpause rules set successfully");

  // Verify rules are set
  console.log("Verifying rules...");

  try {
    const pauseRule = await controller.getQuorumRule(4, 0);
    console.log("Pause rule min amount:", pauseRule.minAmount.toString());
    console.log("Pause rule max amount:", pauseRule.maxAmount.toString());
    console.log("Pause rule required roles:", pauseRule.requiredRoles);
  } catch (error: any) {
    console.error("Error getting pause rule:", error.message);
  }

  try {
    const unpauseRule = await controller.getQuorumRule(5, 0);
    console.log("Unpause rule min amount:", unpauseRule.minAmount.toString());
    console.log("Unpause rule max amount:", unpauseRule.maxAmount.toString());
    console.log("Unpause rule required roles:", unpauseRule.requiredRoles);
  } catch (error: any) {
    console.error("Error getting unpause rule:", error.message);
  }

  console.log("Setup complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

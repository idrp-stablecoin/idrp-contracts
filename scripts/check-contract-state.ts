import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import hre from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const networkId = hre.network.config.chainId ?? 8545;
  console.log("Deployer:", deployer.address);

  // Addresses to check
  const addresses = {
    deployer: deployer.address,
    officer: "0x99A0AD5DF1651D8812B0b4Ca5102ad060C4DC2d3",
    manager: "0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761",
    director: "0x5B2A48685a89458ECbaB3AEC56923e128f441995",
    commissioner: "0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed",
  };

  // Define role constants
  const OFFICER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OFFICER_ROLE"));
  const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
  const DIRECTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DIRECTOR_ROLE"));
  const COMMISSIONER_ROLE = ethers.keccak256(
    ethers.toUtf8Bytes("COMMISSIONER_ROLE")
  );
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

  // Load contract addresses from deployment file
  const deployments = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployment/chain-" + networkId + ".json"),
      "utf-8"
    )
  );

  // Connect to deployed contracts
  const idrp = await ethers.getContractAt("IDRP", deployments["IDRP"]);
  console.log("\nIDRP token address:", await idrp.getAddress());

  // Check IDRP token state
  console.log("\n--- IDRP Token State ---");
  console.log("Paused:", await idrp.paused());
  console.log("Depository wallet:", await idrp.depositoryWallet());

  const controller = await ethers.getContractAt(
    "IDRPController",
    deployments["IDRPController"]
  );
  console.log("\nIDRPController address:", await controller.getAddress());

  // Check controller state
  console.log("\n--- Controller State ---");
  console.log("Current nonce:", await controller.nonce());
  console.log("IDRP token:", await controller.idrpToken());

  // Check permissions on IDRP token
  console.log("\n--- IDRP Token Permissions ---");
  const PAUSER_ROLE = await idrp.PAUSER_ROLE();
  const MINTER_ROLE = await idrp.MINTER_ROLE();
  const FREEZER_ROLE = await idrp.FREEZER_ROLE();

  console.log("PAUSER_ROLE:", PAUSER_ROLE);
  console.log("MINTER_ROLE:", MINTER_ROLE);
  console.log("FREEZER_ROLE:", FREEZER_ROLE);

  console.log(
    "Controller has PAUSER_ROLE:",
    await idrp.hasRole(PAUSER_ROLE, controller.target)
  );
  console.log(
    "Controller has MINTER_ROLE:",
    await idrp.hasRole(MINTER_ROLE, controller.target)
  );
  console.log(
    "Controller has FREEZER_ROLE:",
    await idrp.hasRole(FREEZER_ROLE, controller.target)
  );
  console.log(
    "Controller has PAUSER_ROLE:",
    await idrp.hasRole(PAUSER_ROLE, controller.target)
  );
  console.log(
    "Deployer has PAUSER_ROLE:",
    await idrp.hasRole(PAUSER_ROLE, deployer.address)
  );

  // Check role assignments on controller
  console.log("\n--- Controller Role Assignments ---");
  const roles = [
    { name: "DEFAULT_ADMIN_ROLE", value: DEFAULT_ADMIN_ROLE },
    { name: "ADMIN_ROLE", value: ADMIN_ROLE },
    { name: "OFFICER_ROLE", value: OFFICER_ROLE },
    { name: "MANAGER_ROLE", value: MANAGER_ROLE },
    { name: "DIRECTOR_ROLE", value: DIRECTOR_ROLE },
    { name: "COMMISSIONER_ROLE", value: COMMISSIONER_ROLE },
  ];

  for (const address of Object.entries(addresses)) {
    const [role, addr] = address;
    console.log(`\nChecking roles for ${role} (${addr}):`);

    for (const r of roles) {
      const hasRole = await controller.hasRole(r.value, addr);
      console.log(`- ${r.name}: ${hasRole}`);
    }
  }

  // Try to get the pause quorum rule
  console.log("\n--- Pause Quorum Rule ---");
  try {
    const pauseQuorumRule = await controller.getQuorumRule(4, 0);
    console.log("Pause min amount:", pauseQuorumRule.minAmount.toString());
    console.log("Pause max amount:", pauseQuorumRule.maxAmount.toString());
    console.log("Pause required roles:", pauseQuorumRule.requiredRoles);
  } catch (error: any) {
    console.error("Error getting pause quorum rule:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

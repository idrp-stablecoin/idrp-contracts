import fs from "fs";
import path from "path";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Get the deployment file path for a specific network
 */
export function getDeploymentFilePath(
  hre: HardhatRuntimeEnvironment,
  chainId: number
): string {
  const deploymentDir = path.join(
    hre.config.paths.root || process.cwd(),
    "./deployment"
  );

  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  return path.join(deploymentDir, `chain-${chainId}.json`);
}

/**
 * Load existing deployments from file
 */
export function loadDeployments(
  deploymentFile: string
): Record<string, string> {
  if (fs.existsSync(deploymentFile)) {
    try {
      return JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
    } catch (error) {
      console.warn(`Failed to parse deployment file: ${deploymentFile}`);
      return {};
    }
  }
  return {};
}

/**
 * Save deployments to file
 */
export function saveDeployments(
  deploymentFile: string,
  deployments: Record<string, string>
): void {
  fs.writeFileSync(deploymentFile, JSON.stringify(deployments, null, 2));
}

/**
 * Update a single deployment
 */
export function updateDeployment(
  deploymentFile: string,
  contractName: string,
  contractAddress: string
): void {
  const deployments = loadDeployments(deploymentFile);
  deployments[contractName] = contractAddress;
  saveDeployments(deploymentFile, deployments);
}

/**
 * Get a deployed contract address
 */
export function getDeployedAddress(
  deploymentFile: string,
  contractName: string
): string | null {
  const deployments = loadDeployments(deploymentFile);
  return deployments[contractName] || null;
}

/**
 * Check if a contract is already deployed
 */
export function isContractDeployed(
  deploymentFile: string,
  contractName: string
): boolean {
  const deployments = loadDeployments(deploymentFile);
  return !!deployments[contractName];
}

/**
 * Log deployment info
 */
export function logDeploymentInfo(
  contractName: string,
  contractAddress: string,
  deploymentFile: string
): void {
  console.log(`✓ ${contractName} deployed to: ${contractAddress}`);
  console.log(`  Saved to: ${deploymentFile}`);
}

/**
 * Log skip info
 */
export function logSkipInfo(
  contractName: string,
  contractAddress: string
): void {
  console.log(`⊘ ${contractName} already deployed to: ${contractAddress}`);
}

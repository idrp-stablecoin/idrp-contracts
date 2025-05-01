import fs from "fs"
import path from "path"
import hre from "hardhat"

async function main() {
  const networkId = hre.network.config.chainId ?? 8545
  const deploymentDir = path.join(hre.config.paths.root || process.cwd(), "./deployment")

  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true })
  }

  const deploymentFile = path.join(deploymentDir, `chain-${networkId}.json`)

  // Fetch existing deployments
  let deployments: Record<string, string> = {}
  if (fs.existsSync(deploymentFile)) {
    deployments = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"))
  }

  const proxyAddress = deployments["IDRP"]
  const IDRP = await hre.ethers.getContractFactory("IDRP")
  const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, IDRP)

  console.log("Upgraded IDRP to:", await upgraded.getAddress())
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

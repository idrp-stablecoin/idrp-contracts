import { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-dependency-compiler";

// const PRIVATE_KEY = vars.get("PRIVATE_KEY")
const IDRP_DEPLOYER_PRIVATE_KEY = vars.get("IDRP_DEPLOYER_PRIVATE_KEY");
const ETHERSCAN_API_KEY = vars.get("ETHERSCAN_API_KEY");
const ALCHEMY_API_KEY = vars.get("ALCHEMY_API_KEY");
const POLYGON_API_KEY = vars.get("POLYGON_API_KEY");

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    holesky: {
      chainId: 17000,
      // url: "https://ethereum-holesky-rpc.publicnode.com",
      url: `https://eth-holesky.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,

      accounts: [IDRP_DEPLOYER_PRIVATE_KEY],
    },
    polygon: {
      chainId: 137,
      url: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: {
      holesky: ETHERSCAN_API_KEY,
      polygon: POLYGON_API_KEY,
    },
  },
  dependencyCompiler: {
    paths: [
      "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol",
    ],
  },
};

export default config;

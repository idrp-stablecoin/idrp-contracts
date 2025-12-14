import { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-dependency-compiler";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";

// const PRIVATE_KEY = vars.get("PRIVATE_KEY")
const IDRP_DEPLOYER_PRIVATE_KEY = vars.get("IDRP_DEPLOYER_PRIVATE_KEY");
const IDRP_ADMIN_PRIVATE_KEY = vars.get("IDRP_ADMIN_PRIVATE_KEY");
const ETHERSCAN_API_KEY = vars.get("ETHERSCAN_API_KEY");
const ALCHEMY_API_KEY = vars.get("ALCHEMY_API_KEY");
const INFURA_API_KEY = vars.get("INFURA_API_KEY");
const POLYGON_API_KEY = vars.get("POLYGON_API_KEY");
const KAIROS_API_KEY = vars.get("KAIROS_API_KEY");
const KAIA_API_KEY = vars.get("KAIA_API_KEY");

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // viaIR: true,
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    holesky: {
      chainId: 17000,
      // url: "https://ethereum-holesky-rpc.publicnode.com",
      url: `https://eth-holesky.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
    },
    sepolia: {
      chainId: 11155111,
      url: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
    },
    polygon: {
      chainId: 137,
      url: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
    },
    mainnet: {
      chainId: 1,
      // url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      url: `https://mainnet.infura.io/v3/${INFURA_API_KEY}`,
      // url: "https://eth.llamarpc.com",
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
      // gasPrice: "auto", // Let hardhat estimate the gas price
      // gasMultiplier: 1.5, // Add 50% buffer to estimated gas
      // timeout: 1800000, // 30 minutes
    },
    kairos: {
      chainId: 1001,
      url: "https://rpc.ankr.com/kaia_testnet",
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
      gasPrice: 250000000000,
    },
    bsc: {
      chainId: 56,
      // url: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      url: `https://bsc-mainnet.infura.io/v3/${INFURA_API_KEY}`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
      // gasMultiplier: 1.1, // Add 10% buffer to estimated gas
    },
    baseSepolia: {
      chainId: 84532,
      url: `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
      gasMultiplier: 1.1, // Add 10% buffer to estimated gas
    },
    kaia: {
      chainId: 8217,
      url: `https://public-en.node.kaia.io`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
    },
  },
  etherscan: {
    // apiKey: {
    //   holesky: ETHERSCAN_API_KEY,
    //   sepolia: ETHERSCAN_API_KEY,
    //   polygon: ETHERSCAN_API_KEY,
    //   mainnet: ETHERSCAN_API_KEY,
    //   kairos: KAIROS_API_KEY || "unnecessary", // see: https://docs.kaiascan.io/smart-contract-verification/hardhat-verify#kairos
    //   bsc: ETHERSCAN_API_KEY,
    //   kaia: KAIA_API_KEY || "unnecessary",
    // },
    apiKey: ETHERSCAN_API_KEY,
    customChains: [
      {
        chainId: 1001,
        network: "kairos",
        urls: {
          apiURL: "https://kairos-api.kaiascan.io/hardhat-verify",
          browserURL: "https://kairos.kaiascan.io",
        },
      },
      {
        chainId: 56,
        network: "bsc",
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=56",
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "kaia",
        chainId: 8217,
        urls: {
          apiURL: "https://mainnet-api.kaiascan.io/hardhat-verify",
          browserURL: "https://kaiascan.io",
        },
      },
    ],
  },
  dependencyCompiler: {
    paths: [
      "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol",
    ],
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
    token: "ETH",
    gasPrice: 0.1,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    excludeContracts: [],
    src: "./contracts",
    // etherscan: vars.get("ETHERSCAN_API_KEY")
  },
  sourcify: {
    // Disabled by default
    // Doesn't need an API key
    enabled: true,
  },
};

export default config;

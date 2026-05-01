import { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-dependency-compiler";
import "@layerzerolabs/hardhat-deploy";
import "@layerzerolabs/hardhat-tron";

const tronToHex = (tronKey: string): string => {
  if (tronKey.startsWith("0x")) {
    return tronKey; // Already in hex format
  }
  return "0x" + tronKey; // Convert to hex format
}

// const PRIVATE_KEY = vars.get("PRIVATE_KEY")
const IDRP_DEPLOYER_PRIVATE_KEY = tronToHex(vars.get("IDRP_DEPLOYER_PRIVATE_KEY"));
const IDRP_ADMIN_PRIVATE_KEY = tronToHex(vars.get("IDRP_ADMIN_PRIVATE_KEY"));
const IDRP_DEPLOYER_PRIVATE_KEY_TRON = tronToHex(vars.get(
  "IDRP_DEPLOYER_PRIVATE_KEY_TRON"
));
const IDRP_ADMIN_PRIVATE_KEY_TRON = tronToHex(vars.get("IDRP_ADMIN_PRIVATE_KEY_TRON"));
const ETHERSCAN_API_KEY = vars.get("ETHERSCAN_API_KEY");
const ALCHEMY_API_KEY = vars.get("ALCHEMY_API_KEY");
const INFURA_API_KEY = vars.get("INFURA_API_KEY");
// const POLYGON_API_KEY = vars.get("POLYGON_API_KEY");
// const KAIROS_API_KEY = vars.get("KAIROS_API_KEY");

const config: HardhatUserConfig = {
  solidity: {
  version: "0.8.20",       // ← OZ v4 support 0.8.20
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    evmVersion: "istanbul", // ← OZ v4 kompatibel dengan istanbul
  },
},
  namedAccounts: {
    deployer: {
      default: 0,
    },
    admin: {
      default: 1,
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

    // TVM: @layerzerolabs/hardhat-tron
    shasta: {
      url: "https://api.shasta.trongrid.io/jsonrpc",
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY_TRON, IDRP_ADMIN_PRIVATE_KEY_TRON],
      tron: true,
    },
    nile: {
      // Tron Nile testnet JSON-RPC endpoint
      url: "https://nile.trongrid.io/jsonrpc",
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY_TRON, IDRP_ADMIN_PRIVATE_KEY_TRON],
      tron: true,
    },
    tron: {
      // Tron mainnet JSON-RPC endpoint via TronGrid (free tier: https://www.trongrid.io/)
      url: "https://api.trongrid.io/jsonrpc",
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY_TRON, IDRP_ADMIN_PRIVATE_KEY_TRON],
      tron: true,
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
    enabled: true,
  },

  // TVM: @layerzerolabs/hardhat-tron
  tronSolc: {
    enable: true,
    filter: [], // compile all contracts
    compilers: [
      {
        version: "0.8.22",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        } as any,
      },
    ],
  },
};

export default config;

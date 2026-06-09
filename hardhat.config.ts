import { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-dependency-compiler";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";
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
const POLYGON_API_KEY = vars.get("POLYGON_API_KEY");
const KAIROS_API_KEY = vars.get("KAIROS_API_KEY");
const KAIA_API_KEY = vars.get("KAIA_API_KEY");

const config: HardhatUserConfig = {
  solidity: {
    // Multiple compilers:
    //   0.8.28 — EVM target (paris evmVersion), main's pin.
    //   0.8.22 — Tron target. evmVersion: istanbul is required here (NOT in
    //            tronSolc.compilers[].settings) because @layerzerolabs/hardhat-tron's
    //            updateCompilerConf only forwards optimizer + metadata settings,
    //            not evmVersion. The compile pipeline copies solidity.compilers
    //            settings as the base, then tronSolc overrides only the
    //            optimizer/metadata bits. So evmVersion must be set at the
    //            solidity.compilers level.
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        version: "0.8.22",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "istanbul",
        },
      },
    ],
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
    kaia: {
      chainId: 8217,
      url: `https://public-en.node.kaia.io`,
      accounts: [IDRP_DEPLOYER_PRIVATE_KEY, IDRP_ADMIN_PRIVATE_KEY],
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
    // `apiKey` mode picker (READ THIS BEFORE VERIFYING ON KAIA / KAIROS):
    //
    // - String form (this default): forces hardhat-verify v2 mode, which
    //   routes through `api.etherscan.io/v2/api?chainid=<id>`. Works for
    //   every Etherscan-derived explorer (Basescan, BSCscan, Polygonscan,
    //   Sepolia, Holesky, etc.). Does NOT work for Kaia / Kairos — chainId
    //   1001 / 8217 are not on the Etherscan v2 chainlist, so the request
    //   fails with "Missing or unsupported chainid parameter".
    //
    // - Object form (commented out below): forces hardhat-verify v1 mode,
    //   which uses each network's `customChains[i].urls.apiURL`. This works
    //   for Kaia / Kairos (Kaiascan has its own non-Etherscan endpoint) but
    //   triggers a "deprecated V1 endpoint" warning for Etherscan-derived
    //   explorers (Basescan still verifies, just noisily).
    //
    // To verify on Kaia / Kairos: temporarily swap to the object form below.
    // Then revert back to the string form for everything else. (We'd ideally
    // mix modes per-network, but hardhat-verify treats the choice as binary.)
    apiKey: ETHERSCAN_API_KEY,
    // apiKey: {
    //   sepolia: ETHERSCAN_API_KEY,
    //   holesky: ETHERSCAN_API_KEY,
    //   polygon: ETHERSCAN_API_KEY,
    //   mainnet: ETHERSCAN_API_KEY,
    //   bsc: ETHERSCAN_API_KEY,
    //   baseSepolia: ETHERSCAN_API_KEY,
    //   kairos: KAIROS_API_KEY || "unnecessary",
    //   kaia: KAIA_API_KEY || "unnecessary",
    // },
    customChains: [
      {
        chainId: 1001,
        network: "kairos",
        urls: {
          apiURL: "https://compiler-api-v2.kaiascan.io/kairos/hardhat-verify",
          browserURL: "https://kairos.kaiascan.io",
        },
      },
      {
        chainId: 8217,
        network: "kaia",
        urls: {
          apiURL: "https://compiler-api-v2.kaiascan.io/mainnet/hardhat-verify",
          browserURL: "https://kaiascan.io",
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
  //
  // tron-solc 0.8.22 is published at
  // https://tronsuper.github.io/tron-solc-bin/bin/soljson_v0.8.22.js but
  // isn't yet in the plugin's hardcoded version list (latest in
  // node_modules/@layerzerolabs/hardhat-tron/dist/constants.js is 0.8.20).
  // The plugin's validateTronSolcVersion warns "unknown version, attempting
  // anyway..." for versions greater than 0.8.20 and proceeds to download.
  // So 0.8.22 works.
  //
  // Main's solc target is 0.8.28 (paris evmVersion); only 0.8.22 is needed
  // for Tron (istanbul). Remap 0.8.28 → 0.8.22 so the Tron build uses the
  // same source files.
  tronSolc: {
    enable: true,
    filter: [], // compile all contracts
    versionRemapping: [
      ["0.8.28", "0.8.22"],
    ],
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

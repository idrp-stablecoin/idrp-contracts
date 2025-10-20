require("dotenv").config();

module.exports = {
  networks: {
    development: {
      // For tronbox/tre docker image
      // See https://hub.docker.com/r/tronbox/tre
      privateKey: process.env.PRIVATE_KEY_DEVELOPMENT,
      userFeePercentage: 0, // The percentage of resource consumption ratio.
      feeLimit: 1000 * 1e6, // The TRX consumption limit for the deployment and trigger, unit is SUN
      fullHost: "http://127.0.0.1:9090",
      network_id: "*",
    },
    shasta: {
      // Obtain test coin at https://shasta.tronex.io/
      privateKey: process.env.PRIVATE_KEY_SHASTA,
      userFeePercentage: 50,
      feeLimit: 1000 * 1e6,
      fullHost: "https://api.shasta.trongrid.io",
      network_id: "2",
    },
  },
  compilers: {
    solc: {
      version: "0.8.22",
      // An object with the same schema as the settings entry in the Input JSON.
      // See https://docs.soliditylang.org/en/latest/using-the-compiler.html#input-description
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
        evmVersion: "istanbul",
        viaIR: true,
      },
    },
  },
};

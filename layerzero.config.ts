import { EndpointId } from "@layerzerolabs/lz-definitions";
import { ExecutorOptionType } from "@layerzerolabs/lz-v2-utilities";
import {
  TwoWayConfig,
  generateConnectionsConfig,
} from "@layerzerolabs/metadata-tools";
import { OAppEnforcedOption } from "@layerzerolabs/toolbox-hardhat";

import type { OmniPointHardhat } from "@layerzerolabs/toolbox-hardhat";

const baseContract: OmniPointHardhat = {
  eid: EndpointId.BASESEP_V2_TESTNET,
  contractName: "IDRPOFTAdapterUpgradeable",
};

const arbitrumContract: OmniPointHardhat = {
  eid: EndpointId.ARBSEP_V2_TESTNET,
  contractName: "IDRPOFTUpgradeable",
};

const sepoliaContract: OmniPointHardhat = {
  eid: EndpointId.SEPOLIA_V2_TESTNET,
  contractName: "IDRPOFTUpgradeable",
};

const tronContract: OmniPointHardhat = {
  eid: EndpointId.TRON_V2_TESTNET,
  contractName: "IDRPOFTUpgradeable",
  // address: "TGs6gVP1W8m8kqBcfZNjPnmtPPAWdhdGS2", // deployed address on Shasta
  address: "0x4bA11be2056CCa41Ee31b9b6239a883dcBA8B293", // deployed address on Shasta
};

// For this example's simplicity, we will use the same enforced options values for sending to all chains
// For production, you should ensure `gas` is set to the correct value through profiling the gas usage of calling OFT._lzReceive(...) on the destination chain
// To learn more, read https://docs.layerzero.network/v2/concepts/applications/oapp-standard#execution-options-and-enforced-settings
const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
  // BROADCAST message type (custom)
  {
    msgType: 0,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 65000,
    value: 0,
  },
  // SEND message type
  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 80000,
    value: 0,
  },
];
// With the config generator, pathways declared are automatically bidirectional
// i.e. if you declare A,B there's no need to declare B,A
const pathways: TwoWayConfig[] = [
  // Base <-> Arbitrum
  [
    baseContract, // Chain A contract
    arbitrumContract, // Chain B contract
    [["LayerZero Labs"], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    [3, 3], // [A to B confirmations, B to A confirmations]
    [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
  ],
  // Base <-> Sepolia
  [
    baseContract, // Chain A contract
    sepoliaContract, // Chain B contract
    [["LayerZero Labs"], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    [3, 3], // [A to B confirmations, B to A confirmations]
    [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
  ],
  // Base <-> Tron
  [
    baseContract, // Chain A contract
    tronContract, // Chain B contract
    [["LayerZero Labs"], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    [3, 3], // [A to B confirmations, B to A confirmations]
    [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
  ],
  // Arbitrum <-> Sepolia
  // [
  //   arbitrumContract, // Chain A contract
  //   sepoliaContract, // Chain B contract
  //   [["LayerZero Labs"], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
  //   [3, 3], // [A to B confirmations, B to A confirmations]
  //   [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
  // ],
];
// Note: you should not use the values 1, 1 for confirmations. Choose the right number of confirmations based on the finalization that you require from the source/destination chains.

export default async function () {
  // Generate the connections config based on the pathways
  const connections = await generateConnectionsConfig(pathways);
  return {
    contracts: [
      { contract: baseContract },
      { contract: arbitrumContract },
      { contract: sepoliaContract },
      { contract: tronContract },
    ],
    connections,
  };
}

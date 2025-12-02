# LayerZero OFT Integration

This document describes the LayerZero Omnichain Fungible Token (OFT) integration added to the IDRP contracts project.

## Overview

LayerZero OFT enables cross-chain token transfers using the LayerZero protocol. This integration includes upgradeable OFT contracts and deployment infrastructure.

## Structure

### Contracts (`contracts/oft/`)

- **IDRPOFTUpgradeable.sol** - Basic upgradeable OFT implementation
- **IDRPOFTAdapterUpgradeable.sol** - OFT adapter for existing ERC20 tokens
- **IDRPOFTFeeUpgradeable.sol** - OFT with fee mechanisms
- **IDRPOFTAdapterFeeUpgradeable.sol** - OFT adapter with fee mechanisms

### Configuration

- **layerzero.config.ts** - LayerZero network configuration and pathways
- **type-extensions.ts** - TypeScript type extensions for Hardhat config

### Deployment Scripts (`deploy/`)

- **IDRPOFTUpgradeable.ts** - Deploy script for OFT tokens
- **IDRPOFTAdapterUpgradeable.ts** - Deploy script for OFT adapters

### Tasks (`tasks/`)

- **sendOFT.ts** - Hardhat task for sending OFT tokens cross-chain
- **sendEvm.ts** - EVM-specific implementation for OFT transfers
- **types.ts** - TypeScript types for tasks
- **utils.ts** - Utility functions

## Setup

### 1. Configuration

Edit `layerzero.config.ts` to configure your cross-chain pathways:

````typescript
```typescript
const baseContract: OmniPointHardhat = {
    eid: EndpointId.BASESEP_V2_TESTNET,
    contractName: 'IDRPOFTUpgradeable',
}

const arbitrumContract: OmniPointHardhat = {
    eid: EndpointId.ARBSEP_V2_TESTNET,
    contractName: 'IDRPOFTUpgradeable',
}
````

````

Update pathways, DVNs, and enforced options as needed.

## Usage

### Compile Contracts

```bash
npm run compile
````

### Deploy OFT

For a new OFT token:

```bash
npx hardhat deploy --network <network-name> --tags IDRPOFTUpgradeable
```

For an OFT adapter (wrapping existing token):

1. Configure the token address in your network config:

```typescript
networks: {
  'base-sepolia': {
    // ... other config
    oftAdapter: {
      tokenAddress: '0x...' // Your existing ERC20 token
    }
  }
}
```

2. Deploy:

```bash
npx hardhat deploy --network <network-name> --tags IDRPOFTAdapterUpgradeable
```

### Send OFT Tokens Cross-Chain

```bash
npx hardhat lz:oft:send \
  --network <source-network> \
  --src-eid <source-endpoint-id> \
  --dst-eid <destination-endpoint-id> \
  --amount <amount> \
  --to <recipient-address>
```

Example:

```bash
npx hardhat lz:oft:send \
  --network base-sepolia \
  --src-eid 40245 \
  --dst-eid 40231 \
  --amount "1.5" \
  --to "0x1234567890123456789012345678901234567890"
```

### Additional Options

```bash
# Specify minimum amount (for slippage/fees)
--min-amount "1.4"

# Override OFT address
--oft-address "0x..."

# Add custom lzReceive options (gas, value)
--extra-lz-receive-options "200000,0"

# Add compose message
--compose-msg "0x1234..."
```

## Network Configuration

The hardhat config now includes:

- **Multiple Solidity compilers** (0.8.28 for IDRP, 0.8.22 for OFT)
- **LayerZero toolbox** integration
- **hardhat-deploy** for deployment management
- **Named accounts** configuration

## LayerZero Resources

- [LayerZero Documentation](https://docs.layerzero.network/)
- [OFT Standard](https://docs.layerzero.network/v2/concepts/applications/oapp-standard)
- [Endpoint IDs](https://docs.layerzero.network/v2/concepts/protocol/endpoints)
- [LayerZero Scan](https://layerzeroscan.com/) - Track cross-chain transactions

## Important Notes

1. **Gas Settings**: Default enforced options use 80,000 gas for `lzReceive`. Profile your specific use case and adjust in `layerzero.config.ts`.

2. **Confirmations**: Default pathway configuration uses `[1, 1]` confirmations. For production, increase this based on your security requirements.

3. **DVN Configuration**: Default uses `[['LayerZero Labs'], []]`. For production, consider adding multiple DVNs for enhanced security.

4. **Contract Names**: Update contract names in `layerzero.config.ts` from `IDRPOFTUpgradeable` to your actual contract names.

5. **Ethers Version**: This project uses ethers v5 for LayerZero compatibility, managed via npm overrides.

## Troubleshooting

### Dependency Conflicts

If you encounter dependency conflicts during installation:

```bash
npm install --legacy-peer-deps
```

### Type Errors

The project includes `type-extensions.ts` for Hardhat type support. Ensure it's imported in `hardhat.config.ts`.

### Network Issues

Verify network configuration includes `eid` (endpoint ID) for LayerZero networks.

## Next Steps

1. Customize OFT contracts in `contracts/oft/` for your use case
2. Update `layerzero.config.ts` with production networks and settings
3. Implement proper access controls and security measures
4. Test thoroughly on testnets before mainnet deployment
5. Set up monitoring and alerting for cross-chain transactions

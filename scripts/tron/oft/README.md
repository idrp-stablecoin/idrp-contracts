# Tron OFT Scripts

Since devtools currently not fully support TRON, we provide scripts to manually wire up OFT connections on TRON Shasta testnet. Below is from the related PR:

- https://github.com/LayerZero-Labs/devtools/pull/1542
- https://github.com/LayerZero-Labs/devtools/tree/feat/add-tron-to-devtools
- https://github.com/LayerZero-Labs/devtools/pull/1540

### Manual Wireup

Since `npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts` fails on TRON (error: `eth_getTransactionCount does not exist`), we run the wiring steps manually using individual scripts.

## Step-by-Step Execution

Run these scripts **in order** on TRON Shasta testnet:

```bash
# Step 1: Set peer (connects to Base Sepolia adapter)
npx ts-node scripts/tron/oft/1-set-peer.ts

# Step 2: Set enforced options (gas limits for cross-chain messages)
npx ts-node scripts/tron/oft/2-set-enforced-options.ts

# Step 3: Set send library (SendULN302)
npx ts-node scripts/tron/oft/3-set-send-library.ts

# Step 4: Set receive library (ReceiveULN302)
npx ts-node scripts/tron/oft/4-set-receive-library.ts

# Step 5a: Configure SendULN302 (executor + DVN)
npx ts-node scripts/tron/oft/5a-set-config-send.ts

# Step 5b: Configure ReceiveULN302 (DVN only)
npx ts-node scripts/tron/oft/5b-set-config-receive.ts
```

**Environment variables required:**

- `PRIVATE_KEY_SHASTA` - Your TRON private key (without 0x prefix)
- `TRONGRID_API_KEY` - TronGrid API key (optional but recommended)

## Alternative: Automated Script

If you prefer, use the automated script that handles all steps and tracks progress:

```bash
# Run all wiring steps automatically (with retry and tx tracking)
npx ts-node scripts/tron/oft/wireup-manual-all.ts
```

This reads from `scripts/tron/oft/data/wiring-txns.json` (generated via `lz:oapp:wire --output-filename`) and injects tx hashes back for tracking.

#### Error Example

- npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts

  ```
  ───────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ error              ProviderError: the method eth_getTransactionCount does not exist/is not         │
  │                    available                                                                       │
  │ Endpoint           TRON_V2_TESTNET                                                                 │
  │ OmniAddress        0x1b356f3030CE0c1eF9D3e1E250Bf0BB11D81b2d1                                      │
  │ OmniContract       -                                                                               │
  │ Function Name      -                                                                               │
  │ Function Arguments -                                                                               │
  │ Description        Setting send library for BASESEP_V2_TESTNET to                                  │
  │                    0xaef63752785Ad2104cea1aa42b69b46f2530312F                                      │
  │ Data               0x9535ff300000000000000000000000004ba11be2056cca41ee31b9b6239a883dcba8b2930000  │
  │                    000000000000000000000000000000000000000000000000000000009d35000000000000000000  │
  │                    000000aef63752785ad2104cea1aa42b69b46f2530312f                                  │
  │ Value              -                                                                               │
  │ Gas Limit          -
  │ ───────────────────────────────────────────────────────────────────────────────────────────────────┘
  ```

### Wiring Data

Running `lz:oapp:wire` will make the following function calls per pathway connection for a fully defined config file using your specified settings and your environment variables (Private Keys and RPCs):

- <a href="https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/oapp/contracts/oapp/OAppCore.sol#L33-L46"><code>function setPeer(uint32 \_eid, bytes32 \_peer) public virtual onlyOwner {}</code></a>

- <a href="https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol#L304-L311"><code>function setConfig(address \_oapp, address \_lib, SetConfigParam[] calldata \_params) external onlyRegistered(\_lib) {}</code></a>

- <a href="https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/oapp/contracts/oapp/libs/OAppOptionsType3.sol#L18-L36"><code>function setEnforcedOptions(EnforcedOptionParam[] calldata \_enforcedOptions) public virtual onlyOwner {}</code></a>

- <a href="https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol#L223-L238"><code>function setSendLibrary(address \_oapp, uint32 \_eid, address \_newLib) external onlyRegisteredOrDefault(\_newLib) isSendLib(\_newLib) onlySupportedEid(\_newLib, \_eid) {}</code></a>

- <a href="https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol#L223-L273"><code>function setReceiveLibrary(address \_oapp, uint32 \_eid, address \_newLib, uint256 \_gracePeriod) external onlyRegisteredOrDefault(\_newLib) isReceiveLib(\_newLib) onlySupportedEid(\_newLib, \_eid) {}</code></a>

> Note: Generate json with `npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts --output-filename ./scripts/tron/oft/data/wiring-txns.json`

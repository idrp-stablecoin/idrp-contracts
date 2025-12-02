# Tron OFT Scripts

### Manual Wireup

Since `npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts` will always failed on Tron (but, others `setPeer` and `setEnforcedOptions` in other chains is fine), we do run `npx ts-node scripts/tron/oft/wireup-manual.ts` to set peer and enforced options for Tron OFT contract.

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

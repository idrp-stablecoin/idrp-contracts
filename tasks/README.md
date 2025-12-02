# Example transfer cross-chain

### Base Sepolia to Tron Shasta

first try got `UNPREDICTABLE_GAS_LIMIT`, second try success:

```
spidey@MBP-Spidey idrp-contracts % npx hardhat lz:oft:send \
  --src-eid 40245 \
  --dst-eid 40420 \
  --amount 20 \
  --to 0xABDAA2FA14D78B83D9DFA84D417DFF9300D6EEC3
info:    oft
info:    OFT Adapter detected - checking ERC20 allowance...
info:    Current allowance: 20000000
info:    Required amount: 20000000
info:    Sufficient allowance already exists
info:    Quoting the native gas cost for the send transaction...
info:    Sending the transaction...
info:     Successfully sent 20 tokens from basesep-testnet to tron-testnet
info:     Explorer link for source chain basesep-testnet: https://sepolia.basescan.org/tx/0xdc7605b6287c917cb485487472c36e1c664dfa76c27c11576917c9dfa8558093
info:     LayerZero Scan link for tracking all cross-chain transaction details: https://testnet.layerzeroscan.com/tx/0xdc7605b6287c917cb485487472c36e1c664dfa76c27c11576917c9dfa8558093
spidey@MBP-Spidey idrp-contracts %

```

but, still had an issue, the message status is blocked: https://testnet.layerzeroscan.com/tx/0xdc7605b6287c917cb485487472c36e1c664dfa76c27c11576917c9dfa8558093.

try increase gas:

```
spidey@MBP-Spidey idrp-contracts % npx hardhat lz:oft:send \
  --src-eid 40245 \
  --dst-eid 40420 \
  --amount 20 \
  --to 0xABDAA2FA14D78B83D9DFA84D417DFF9300D6EEC3 \
--extra-lz-receive-options "200000,0"
info:    oft
info:    OFT Adapter detected - checking ERC20 allowance...
info:    Current allowance: 20000000
info:    Required amount: 20000000
info:    Sufficient allowance already exists
info:    Added lzReceive option: 200000 gas, 0 value
info:    Quoting the native gas cost for the send transaction...
info:    Sending the transaction...
info:     Successfully sent 20 tokens from basesep-testnet to tron-testnet
info:     Explorer link for source chain basesep-testnet: https://sepolia.basescan.org/tx/0x76f42c405f0b4aafda3bb4fb6732eb22c0487cd1d332de1705c84f503cf5d4c3
info:     LayerZero Scan link for tracking all cross-chain transaction details: https://testnet.layerzeroscan.com/tx/0x76f42c405f0b4aafda3bb4fb6732eb22c0487cd1d332de1705c84f503cf5d4c3
spidey@MBP-Spidey idrp-contracts %
```

still blocked: https://testnet.layerzeroscan.com/tx/0x76f42c405f0b4aafda3bb4fb6732eb22c0487cd1d332de1705c84f503cf5d4c3

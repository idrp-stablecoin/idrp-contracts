# Build settings for 2026-06-09 Nile v3 impl deploy

These two flattened files MUST be verified with exactly these compiler
settings. Anything else and TronScan will reject the bytecode match.

| Setting | Value |
|---|---|
| Compiler version | `0.8.22+commit.5ed3e10f` (a.k.a. `v0.8.22+commit.5ed3e10f` in the TronScan dropdown — pick whichever entry the dropdown shows for 0.8.22) |
| Optimizer | enabled |
| Optimizer runs | 200 |
| EVM version | paris |
| License | MIT |

## File ↔ on-chain impl

| File | Implementation address | T-format |
|---|---|---|
| `IDRP-impl-0xdB10-2D1c.flat.sol` | `0xdB1056806438fd8aCBDfa2D61a417dB33eB52D1c` | `TVwWZFGYop7QmdHAUWF219PTC3SUnyYhpb` |
| `IDRPController-impl-0x7994-cf64.flat.sol` | `0x799439c8E6cCad5c06b07211c123fb1e2837cf64` | `TM44LB4CKmG6n9YNEXcmY9xcpzhd67LzuS` |

## TESTNET-LOCAL constants baked into these specific impls

These differ from mainnet:

- IDRP: `UPGRADE_DELAY = 5 minutes` (line ~5380 in the flat file)
- IDRPController: `UPGRADE_DELAY = 5 minutes` and `DEFAULT_ADMIN_DELAY = 5 minutes`

Mainnet impls would use `48 hours` for both. The 5-min testnet variants
are produced by a worktree-local uncommitted edit to `contracts/IDRP.sol`
and `contracts/IDRPController.sol` — see commit `d2a879f` (tron-v5
baseline) for the un-edited source.

## Source provenance

Built from commit `d2a879f` (tron-v5) with the 5-min TESTNET-LOCAL
override applied in the `nile-v3-deploy` worktree on 2026-06-09. OZ
dependencies pinned at v5.3.0 exactly (NOT ^5.3.0 — important, because
OZ 5.6+ uses `^0.8.24` pragmas that tron-solc 0.8.22 cannot parse).

## How to verify pragmas are correct

A clean flat file should contain ONLY these pragma versions:
- `pragma solidity ^0.8.20;` (most files)
- `pragma solidity ^0.8.22;` (IDRP.sol and IDRPController.sol)

If you see `^0.8.24` or higher, the file was generated from a newer
OZ version that's incompatible with tron-solc 0.8.22. Quick check:

```bash
grep -nE "^pragma solidity \^0\.8\.(24|25|26|27|28|29)" <flat-file>
# should print nothing
```

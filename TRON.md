# IDRP — Tron Deployment Guide

Complete step-by-step guide: wallet configuration → deploy → flatten → verify on TronScan.

---

## Dependencies

| Package | Role |
|---|---|
| `@layerzerolabs/hardhat-tron` | TVM-compatible Hardhat network adapter |
| `@layerzerolabs/hardhat-deploy` | Deterministic deployment via `deploy/` scripts |

## Generated Files

| Path | Description |
|---|---|
| `hardhat.config.ts` | Network config (`shasta`, `tron`) |
| `deploy/` | Ordered deployment scripts |
| `artifacts-tron/` | TVM-compiled artifacts |
| `cache-tron/` | TVM compilation cache |
| `deployments/shasta/` | On-chain deployment records (auto-created) |
| `flattened/` | Single-file sources for TronScan |

---

## Prerequisites

- **Node.js** ≥ 18 (`node -v`)
- **TRX balance** on the deployer wallet
  - Shasta faucet: https://shasta.tronex.io/
  - Mainnet: purchase TRX and activate the account with at least 1 TRX
- All addresses in `scripts/utils/constants.ts` updated to real wallets before mainnet deployment

---

## Step 1 — Prepare Wallets

You need two wallets for deployment:

| Wallet | Variable | Role |
|---|---|---|
| Deployer | `IDRP_DEPLOYER_PRIVATE_KEY_TRON` | Pays energy/bandwidth; deploys proxy & implementation |
| Admin | `IDRP_ADMIN_PRIVATE_KEY_TRON` | Becomes `DEFAULT_ADMIN_ROLE` owner of both contracts |

### Get Your Tron Private Key

Tron private keys are raw 64-character hex strings.

- **TronLink browser extension** → Settings → Export Private Key → copies hex string
- **TronWeb**: `tronWeb.defaultPrivateKey` in the console
- **Hardware wallet (Ledger)**: use TronLink's Ledger integration and export the derived key for testnet only

> **Security**: never put mainnet private keys in `.env` files or version-controlled files.  
> Use Hardhat's encrypted config variables (Step 2).

### Update Wallet Addresses in `scripts/utils/constants.ts`

Open the file and replace the placeholder addresses with your real Tron base58 addresses (`T...`):

```ts
const TRON_ADMIN_ADDRESS        = "T...";   // Admin / Safe multi-sig
const TRON_OFFICER_ADDRESS      = "T...";   // Officer role
const TRON_MANAGER_ADDRESS      = "T...";   // Manager role
const TRON_DIRECTOR_ADDRESS     = "T...";   // Director role
const TRON_COMMISSIONER_ADDRESS = "T...";   // Commissioner role
const TRON_DEPOSITORY_ADDRESS   = "T...";   // Depository wallet (mint target)
```

The deploy scripts automatically convert these base58 addresses to `0x...` hex format
using `scripts/utils/addressConverter.ts`.

---

## Step 2 — Set Private Keys (Hardhat Vars)

Hardhat stores secrets in an encrypted local vault, not in `.env` files.
Run each command and enter the key when prompted:

```bash
# Deployer private key for Tron (hex, with 0x prefix)
npx hardhat vars set IDRP_DEPLOYER_PRIVATE_KEY_TRON

# Admin private key for Tron (hex, with 0x prefix)
npx hardhat vars set IDRP_ADMIN_PRIVATE_KEY_TRON

# EVM deployer / admin keys (required by hardhat.config.ts even on Tron networks)
npx hardhat vars set IDRP_DEPLOYER_PRIVATE_KEY
npx hardhat vars set IDRP_ADMIN_PRIVATE_KEY

# API keys (can be dummy values if only deploying to Tron)
npx hardhat vars set ETHERSCAN_API_KEY
npx hardhat vars set ALCHEMY_API_KEY
npx hardhat vars set INFURA_API_KEY
npx hardhat vars set POLYGON_API_KEY
npx hardhat vars set KAIROS_API_KEY
```

> **Key format**: Hardhat expects `0x`-prefixed hex strings in the `accounts` array.  
> Convert your Tron key: if your exported key is `abcdef123...` (64 chars, no prefix), store it as `0xabcdef123...`.

Verify all vars are set:

```bash
npx hardhat vars list
```

---

## Step 3 — Compile

```bash
npx hardhat compile
```

Expected output:
```
Compiled 46 Solidity files successfully (evm target: cancun).
```

The `tronSolc` section in `hardhat.config.ts` compiles a TVM-specific artifact set in `artifacts-tron/`.

---

## Step 4 — Deploy to Shasta (Testnet)

Always deploy and verify on Shasta before mainnet.

```bash
npx hardhat deploy --network shasta
```

The deploy scripts run in order:
1. `01_deploy_idrp.ts` — deploys `IDRP` implementation + ERC1967 proxy, calls `initialize(adminAddress)`
2. `02_deploy_idrp_controller.ts` — deploys `IDRPController` implementation + proxy, calls `initialize(idrpProxy, safeAddress)`

**Example output:**
```
🚀 Deploying IDRP to shasta | Admin: 0x...

deploying "IDRP_Implementation" ...  tx: 0x...
deploying "IDRP" (proxy) ... tx: 0x...
✓ IDRP: T<base58proxy>

🚀 Deploying IDRPController to shasta | Admin: 0x...

deploying "IDRPController_Implementation" ... tx: 0x...
deploying "IDRPController" (proxy) ... tx: 0x...
✓ IDRPController: T<base58proxy>
```

Deployment records are saved to `deployments/shasta/`:
- `IDRP.json` — proxy address + ABI
- `IDRPController.json` — proxy address + ABI

Verify the proxy addresses on **Shasta TronScan**: https://shasta.tronscan.org

---

## Step 5 — Deploy to Tron Mainnet

> Ensure the Shasta deployment and all tests pass before proceeding.

```bash
npx hardhat deploy --network tron
```

The deployer wallet must have sufficient TRX (≈ 1000–2000 TRX recommended for energy/bandwidth).
Deployment records are saved to `deployments/tron/`.

---

## Step 6 — Flatten Contracts

TronScan verification requires a single self-contained `.sol` file.  
Run `hardhat flatten` to produce one:

```bash
# IDRP token contract
npx hardhat flatten contracts/IDRP.sol > flattened/IDRP_Flattened_hh.sol

# IDRPController contract
npx hardhat flatten contracts/IDRPController.sol > flattened/IDRPController_Flattened_hh.sol

# ERC1967Proxy (the UUPS proxy shell — needed to verify the proxy address)
npx hardhat flatten node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol > flattened/ERC1967Proxy_Flattened_hh.sol
```

### Fix File Encoding

`hardhat flatten` on Windows may produce a UTF-16 file that TronScan rejects. Convert every flattened file to UTF-8:

**PowerShell (Windows):**
```powershell
foreach ($file in Get-ChildItem flattened\*.sol) {
    $content = Get-Content $file.FullName -Raw -Encoding Unicode
    [System.IO.File]::WriteAllText($file.FullName, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Re-encoded: $($file.Name)"
}
```

**Bash (Linux / macOS):**
```bash
for f in flattened/*.sol; do
    iconv -f UTF-16 -t UTF-8 "$f" -o "${f}.tmp" 2>/dev/null && mv "${f}.tmp" "$f" || true
    # If the file is already UTF-8, iconv fails silently and the original is kept
done
```

> **Note:** If `iconv` reports an error the file was already UTF-8 — that is fine, no action needed.

---

### Remove Duplicate SPDX Headers

Hardhat flatten concatenates all source files. Remove all duplicate license lines
or TronScan will reject the upload:

**PowerShell (Windows):**
```powershell
# Run for each flattened file — replace IDRP with IDRPController / ERC1967Proxy as needed
$file = "flattened\IDRP_Flattened_hh.sol"
(Get-Content $file -Raw) `
  -replace '(?m)^// SPDX-License-Identifier:.*\r?\n', '' | `
  Set-Content $file

# Add a single license header back at the top
"// SPDX-License-Identifier: MIT`n" + (Get-Content $file -Raw) | Set-Content $file
```

**To process all three files at once (PowerShell):**
```powershell
$files = @(
    "flattened\IDRP_Flattened_hh.sol",
    "flattened\IDRPController_Flattened_hh.sol",
    "flattened\ERC1967Proxy_Flattened_hh.sol"
)
foreach ($file in $files) {
    $content = (Get-Content $file -Raw) -replace '(?m)^// SPDX-License-Identifier:.*\r?\n', ''
    "// SPDX-License-Identifier: MIT`n" + $content | Set-Content $file
    Write-Host "Processed: $file"
}
```

**Bash (Linux / macOS):**
```bash
for file in \
    flattened/IDRP_Flattened_hh.sol \
    flattened/IDRPController_Flattened_hh.sol \
    flattened/ERC1967Proxy_Flattened_hh.sol
do
    # Remove all SPDX lines, then prepend a single one
    sed -i '/^\/\/ SPDX-License-Identifier:/d' "$file"
    sed -i '1s/^/\/\/ SPDX-License-Identifier: MIT\n/' "$file"
    echo "Processed: $file"
done
```

---

## Step 7 — Verify on TronScan

There are **two addresses** to verify per deployment:

| Address | What to verify |
|---|---|
| Implementation address (`IDRP_Implementation`) | `IDRP.sol` flattened source |
| Proxy address (`IDRP`) | `ERC1967Proxy.sol` flattened source |

The implementation address is in `deployments/shasta/IDRP_Implementation.json` → `"address"` field.  
The proxy address is in `deployments/shasta/IDRP.json` → `"address"` field.

### 7a — Verify the Implementation Contract

1. Open TronScan:
   - **Shasta**: https://shasta.tronscan.org/#/contracts/verify
   - **Mainnet**: https://tronscan.org/#/contracts/verify

2. Fill in the form:

   | Field | Value |
   |---|---|
   | Contract Address | Implementation address from `deployments/…/IDRP_Implementation.json` |
   | Compiler Version | `v0.8.20+commit.a1b79de6` |
   | License | MIT License (MIT) |
   | Optimization | **Yes** |
   | Optimization Runs | `200` |
   | EVM Version | `istanbul` |
   | Source Code | Paste contents of `flattened/IDRP_Flattened_hh.sol` |
   | ABI-encoded Constructor Arguments | *(leave blank — UUPS implementation has no constructor args)* |

3. Click **Verify and Publish**.

4. Repeat the above for `IDRPController`:
   - Address: `deployments/…/IDRPController_Implementation.json` → `"address"`
   - Source: `flattened/IDRPController_Flattened_hh.sol`

### 7b — Verify the Proxy Contract

1. Verify `ERC1967Proxy` at the **proxy address**:

   | Field | Value |
   |---|---|
   | Contract Address | Proxy address from `deployments/…/IDRP.json` |
   | Compiler Version | `v0.8.20+commit.a1b79de6` |
   | License | MIT |
   | Optimization | **Yes** / 200 runs |
   | EVM Version | `istanbul` |
   | Source Code | `flattened/ERC1967Proxy_Flattened_hh.sol` |
   | ABI-encoded Constructor Arguments | See below |

2. **Encode the constructor arguments** for ERC1967Proxy:

   `ERC1967Proxy(address implementation, bytes memory data)`

   Use the ABI encoder or run:
   ```bash
   npx hardhat run scripts/utils/encode-proxy-args.ts --network shasta
   ```

   Or encode manually with `cast` (Foundry):
   ```bash
   cast abi-encode "constructor(address,bytes)" \
     <IMPLEMENTATION_ADDRESS> \
     <INITIALIZE_CALLDATA>
   ```

   Where `<INITIALIZE_CALLDATA>` is the ABI-encoded `initialize(address)` call.
   For `IDRP.initialize(adminAddress)`:
   ```bash
   cast calldata "initialize(address)" <ADMIN_HEX_ADDRESS>
   ```

3. Paste the resulting hex string (without `0x`) into the **ABI-encoded Constructor Arguments** field.

### 7c — Link Proxy to Implementation on TronScan

After both are verified:

1. Open the **proxy address** on TronScan.
2. Go to the **Contract** tab → click **"Is this a proxy contract?"** or **"More Options → Set as Proxy"**.
3. Enter the implementation address.
4. TronScan will now show the implementation's ABI and source on the proxy page.

---

## Post-Deployment: Grant Roles

After deployment, the Admin wallet must assign operational roles via the controller:

```
ADMIN_ROLE       → IDRPController admin (already granted in initialize)
OFFICER_ROLE     → granted via AccessControl.grantRole()
MANAGER_ROLE     → granted via AccessControl.grantRole()
DIRECTOR_ROLE    → granted via AccessControl.grantRole()
COMMISSIONER_ROLE→ granted via AccessControl.grantRole()
MINTER_ROLE      → granted on IDRP token to IDRPController proxy address
PAUSER_ROLE      → granted on IDRP token to IDRPController proxy address
FREEZER_ROLE     → granted on IDRP token to IDRPController proxy address
UPGRADER_ROLE    → granted on IDRP token to IDRPController proxy address
```

Use `scripts/controller-setup.ts`:

```bash
npx hardhat run scripts/controller-setup.ts --network shasta
```

---

## Quick Reference

```bash
# 1. Set secrets
npx hardhat vars set IDRP_DEPLOYER_PRIVATE_KEY_TRON
npx hardhat vars set IDRP_ADMIN_PRIVATE_KEY_TRON

# 2. Compile
npx hardhat clean
npx hardhat compile

# 3. Deploy (testnet)
npx hardhat deploy --network shasta

# 4. Deploy (mainnet)
npx hardhat deploy --network tron

# 5. Flatten
npx hardhat flatten contracts/IDRP.sol > flattened/IDRP_Flattened_hh.sol
npx hardhat flatten contracts/IDRPController.sol > flattened/IDRPController_Flattened_hh.sol

# 6. Verify → TronScan UI (see Step 7)
```

## Useful Links

| Resource | URL |
|---|---|
| Shasta TronScan | https://shasta.tronscan.org |
| Mainnet TronScan | https://tronscan.org |
| TronScan Verify | https://tronscan.org/#/contracts/verify |
| Shasta Faucet | https://shasta.tronex.io/ |
| TronGrid (RPC) | https://www.trongrid.io/ |
| TronLink Wallet | https://www.tronlink.org/ |

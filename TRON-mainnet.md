# IDRP — Tron Mainnet Deployment Guide

Panduan ini khusus untuk deployment ke **Tron Mainnet** (`--network tron`).  
Pastikan seluruh alur di [TRON.md](./TRON.md) sudah berhasil dijalankan di Nile testnet sebelum melanjutkan.

---

## Pre-Deployment Checklist

Centang semua poin ini sebelum melanjutkan ke mainnet:

- [ ] Deployment di Nile berhasil dan semua kontrak terverifikasi di Nile TronScan
- [ ] Semua tes (`npx hardhat test`) lulus tanpa error
- [ ] Alamat wallet di `scripts/utils/constants.ts` sudah diganti ke alamat mainnet yang benar
- [ ] Deployer wallet memiliki minimal **1.000–2.000 TRX** untuk biaya energy & bandwidth
- [ ] Admin wallet sudah diaktifkan di mainnet (minimal 1 TRX masuk pernah)
- [ ] Private key **tidak** tersimpan di file `.env` atau file yang di-commit ke git
- [ ] Hardhat vars sudah di-set untuk key mainnet (bukan key testnet)

---

## Dependencies

| Package | Role |
|---|---|
| `@layerzerolabs/hardhat-tron` | TVM-compatible Hardhat network adapter |
| `@layerzerolabs/hardhat-deploy` | Deterministic deployment via `deploy/` scripts |

---

## Step 1 — Siapkan Wallet Mainnet

Anda membutuhkan dua wallet:

| Wallet | Variable | Role |
|---|---|---|
| Deployer | `IDRP_DEPLOYER_PRIVATE_KEY_TRON` | Membayar energy/bandwidth; men-deploy proxy & implementation |
| Admin | `IDRP_ADMIN_PRIVATE_KEY_TRON` | Menjadi pemilik `DEFAULT_ADMIN_ROLE` pada kedua kontrak |

> **Keamanan mainnet**: Gunakan wallet yang *hanya* digunakan untuk keperluan ini. Jangan gunakan wallet pribadi atau exchange. Simpan private key di tempat yang aman (hardware wallet atau password manager terenkripsi).

### Update Alamat Wallet di `scripts/utils/constants.ts`

Ganti semua placeholder dengan alamat Tron base58 (`T...`) yang valid untuk mainnet:

```ts
const TRON_ADMIN_ADDRESS        = "T...";   // Admin / Safe multi-sig
const TRON_OFFICER_ADDRESS      = "T...";   // Officer role
const TRON_MANAGER_ADDRESS      = "T...";   // Manager role
const TRON_DIRECTOR_ADDRESS     = "T...";   // Director role
const TRON_COMMISSIONER_ADDRESS = "T...";   // Commissioner role
const TRON_DEPOSITORY_ADDRESS   = "T...";   // Depository wallet (mint target)
```

---

## Step 2 — Set Private Keys (Hardhat Vars)

Hardhat menyimpan secret di vault terenkripsi lokal. Jalankan setiap perintah dan masukkan key saat diminta:

```bash
# Private key Deployer untuk Tron (hex, dengan prefix 0x)
npx hardhat vars set IDRP_DEPLOYER_PRIVATE_KEY_TRON

# Private key Admin untuk Tron (hex, dengan prefix 0x)
npx hardhat vars set IDRP_ADMIN_PRIVATE_KEY_TRON

# EVM keys (diperlukan hardhat.config.ts meski hanya deploy ke Tron)
npx hardhat vars set IDRP_DEPLOYER_PRIVATE_KEY
npx hardhat vars set IDRP_ADMIN_PRIVATE_KEY

# API keys (bisa dummy jika hanya deploy ke Tron)
npx hardhat vars set ETHERSCAN_API_KEY
npx hardhat vars set ALCHEMY_API_KEY
npx hardhat vars set INFURA_API_KEY
npx hardhat vars set POLYGON_API_KEY
npx hardhat vars set KAIROS_API_KEY
```

> **Format key**: Hardhat mengharapkan string hex ber-prefix `0x`.  
> Jika key yang diekspor adalah `abcdef123...` (64 karakter tanpa prefix), simpan sebagai `0xabcdef123...`.

Verifikasi semua vars sudah ter-set:

```bash
npx hardhat vars list
```

---

## Step 3 — Compile

```bash
npx hardhat clean
npx hardhat compile
```

Output yang diharapkan:
```
Compiled 46 Solidity files successfully (evm target: istanbul).
```

---

## Step 4 — Deploy ke Tron Mainnet

```bash
npx hardhat deploy --network tron
```

Script deploy berjalan berurutan:
1. `01_deploy_idrp.ts` — deploy `IDRP` implementation + ERC1967 proxy, panggil `initialize(adminAddress)`
2. `02_deploy_idrp_controller.ts` — deploy `IDRPController` implementation + proxy, panggil `initialize(idrpProxy, safeAddress)`

**Contoh output:**
```
🚀 Deploying IDRP to tron | Admin: 0x...

deploying "IDRP_Implementation" ...  tx: 0x...
deploying "IDRP" (proxy) ... tx: 0x...
✓ IDRP: T<base58proxy>

🚀 Deploying IDRPController to tron | Admin: 0x...

deploying "IDRPController_Implementation" ... tx: 0x...
deploying "IDRPController" (proxy) ... tx: 0x...
✓ IDRPController: T<base58proxy>
```

Record deployment tersimpan di `deployments/tron/`:
- `IDRP.json` — proxy address + ABI
- `IDRP_Implementation.json` — implementation address + ABI
- `IDRPController.json` — proxy address + ABI
- `IDRPController_Implementation.json` — implementation address + ABI

Cek alamat proxy di **TronScan Mainnet**: https://tronscan.org

---

## Step 5 — Flatten Contracts

TronScan verification membutuhkan file `.sol` tunggal yang self-contained.

```bash
# IDRP token contract
npx hardhat flatten contracts/IDRP.sol > flattened/IDRP_Flattened_hh.sol

# IDRPController contract
npx hardhat flatten contracts/IDRPController.sol > flattened/IDRPController_Flattened_hh.sol

# ERC1967Proxy (proxy shell — diperlukan untuk verifikasi alamat proxy)
npx hardhat flatten contracts/utils/ERC1967ProxyCompat.sol > flattened/ERC1967Proxy_Flattened_hh.sol
```

### Fix Encoding File

`hardhat flatten` di Windows bisa menghasilkan file UTF-16 yang ditolak TronScan. Konversi ke UTF-8:

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
done
```

> Jika `iconv` melaporkan error, file sudah UTF-8 — tidak perlu tindakan.

### Hapus Duplikasi Header SPDX

**PowerShell — proses semua sekaligus:**
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
    sed -i '/^\/\/ SPDX-License-Identifier:/d' "$file"
    sed -i '1s/^/\/\/ SPDX-License-Identifier: MIT\n/' "$file"
    echo "Processed: $file"
done
```

---

## Step 6 — Verifikasi di TronScan Mainnet

Ada **dua alamat** yang perlu diverifikasi per kontrak:

| Alamat | Yang diverifikasi |
|---|---|
| Implementation address (`IDRP_Implementation`) | Source `IDRP.sol` (flattened) |
| Proxy address (`IDRP`) | Source `ERC1967Proxy.sol` (flattened) |

Ambil alamat dari file deployment:
- Implementation: `deployments/tron/IDRP_Implementation.json` → field `"address"`
- Proxy: `deployments/tron/IDRP.json` → field `"address"`

### 6a — Verifikasi Implementation Contract

1. Buka: https://tronscan.org/#/contracts/verify

2. Isi form:

   | Field | Value |
   |---|---|
   | Contract Address | Alamat implementation dari `deployments/tron/IDRP_Implementation.json` |
   | Compiler Version | `v0.8.20+commit.a1b79de6` |
   | License | MIT License (MIT) |
   | Optimization | **Yes** |
   | Optimization Runs | `200` |
   | EVM Version | `istanbul` |
   | Source Code | Paste isi `flattened/IDRP_Flattened_hh.sol` |
   | ABI-encoded Constructor Arguments | *(kosongkan — UUPS implementation tidak punya constructor args)* |

3. Klik **Verify and Publish**.

4. Ulangi untuk `IDRPController`:
   - Address: `deployments/tron/IDRPController_Implementation.json` → `"address"`
   - Source: `flattened/IDRPController_Flattened_hh.sol`

### 6b — Verifikasi Proxy Contract

1. Verifikasi `ERC1967Proxy` di **proxy address**:

   | Field | Value |
   |---|---|
   | Contract Address | Alamat proxy dari `deployments/tron/IDRP.json` |
   | Compiler Version | `v0.8.20+commit.a1b79de6` |
   | License | MIT |
   | Optimization | **Yes** / 200 runs |
   | EVM Version | `istanbul` |
   | Source Code | `flattened/ERC1967Proxy_Flattened_hh.sol` |
   | ABI-encoded Constructor Arguments | Lihat di bawah |

2. **Encode constructor arguments** untuk ERC1967Proxy:

   `ERC1967Proxy(address implementation, bytes memory data)`

   Jalankan script encoder:
   ```bash
   npx hardhat run scripts/utils/encode-proxy-args.ts --network tron
   ```

   Atau encode manual dengan `cast` (Foundry):
   ```bash
   cast abi-encode "constructor(address,bytes)" \
     <IMPLEMENTATION_ADDRESS> \
     <INITIALIZE_CALLDATA>
   ```

   Di mana `<INITIALIZE_CALLDATA>` adalah `initialize(address)` yang ter-encode:
   ```bash
   cast calldata "initialize(address)" <ADMIN_HEX_ADDRESS>
   ```

3. Paste hasil hex (tanpa `0x`) ke field **ABI-encoded Constructor Arguments**.

4. Ulangi langkah 6b untuk proxy `IDRPController` menggunakan `deployments/tron/IDRPController.json`.

### 6c — Link Proxy ke Implementation di TronScan

Setelah keduanya terverifikasi:

1. Buka **proxy address** di TronScan.
2. Masuk ke tab **Contract** → klik **"Is this a proxy contract?"** atau **"More Options → Set as Proxy"**.
3. Masukkan implementation address.
4. TronScan akan menampilkan ABI dan source implementation di halaman proxy.

---

## Step 7 — Grant Roles

Setelah deployment, wallet Admin harus menetapkan role operasional melalui controller:

```
ADMIN_ROLE        → IDRPController admin (sudah di-grant saat initialize)
OFFICER_ROLE      → grant via AccessControl.grantRole()
MANAGER_ROLE      → grant via AccessControl.grantRole()
DIRECTOR_ROLE     → grant via AccessControl.grantRole()
COMMISSIONER_ROLE → grant via AccessControl.grantRole()
MINTER_ROLE       → grant pada IDRP token ke alamat proxy IDRPController
PAUSER_ROLE       → grant pada IDRP token ke alamat proxy IDRPController
FREEZER_ROLE      → grant pada IDRP token ke alamat proxy IDRPController
UPGRADER_ROLE     → grant pada IDRP token ke alamat proxy IDRPController
```

Jalankan setup script:

```bash
npx hardhat run scripts/controller-setup.ts --network tron
```

---

## Quick Reference

```bash
# 1. Update alamat di scripts/utils/constants.ts

# 2. Set secrets
npx hardhat vars set IDRP_DEPLOYER_PRIVATE_KEY_TRON
npx hardhat vars set IDRP_ADMIN_PRIVATE_KEY_TRON

# 3. Compile
npx hardhat clean
npx hardhat compile

# 4. Deploy ke mainnet
npx hardhat deploy --network tron

# 5. Flatten
npx hardhat flatten contracts/IDRP.sol > flattened/IDRP_Flattened_hh.sol
npx hardhat flatten contracts/IDRPController.sol > flattened/IDRPController_Flattened_hh.sol
npx hardhat flatten contracts/utils/ERC1967ProxyCompat.sol > flattened/ERC1967Proxy_Flattened_hh.sol

# 6. Verifikasi → TronScan UI (lihat Step 6)

# 7. Grant roles
npx hardhat run scripts/controller-setup.ts --network tron
```

---

## Useful Links

| Resource | URL |
|---|---|
| Mainnet TronScan | https://tronscan.org |
| TronScan Verify | https://tronscan.org/#/contracts/verify |
| TronGrid (RPC) | https://www.trongrid.io/ |
| TronLink Wallet | https://www.tronlink.org/ |
| Nile Testnet Guide | [TRON.md](./TRON.md) |

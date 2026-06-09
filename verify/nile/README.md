# Verify Nile v3 implementations on TronScan — manual walkthrough

> Why manual: TronScan's `nileapi.tronscan.org/api/solidity/contract/verify`
> endpoint is undocumented and inconsistent (Nile vs Shasta param names
> differ; the v0.8.22 compiler-version string is rejected with "compiler
> version error" despite matching the official Tron solc-bin filename).
> The web UI works reliably per Tron's official docs, so we use it.
>
> Both deployed impls are at the addresses below as of 2026-06-09. Verifying
> NOW means when the timelock expires on 2026-06-11 and we execute the
> upgrade, the impls are already verified — nothing left to do post-execute.

## What to verify

| Contract | Tron base58 (paste into TronScan) | Hex |
|---|---|---|
| IDRP impl | `TVwWZFGYop7QmdHAUWF219PTC3SUnyYhpb` | `0xdB1056806438fd8aCBDfa2D61a417dB33eB52D1c` |
| IDRPController impl | `TM44LB4CKmG6n9YNEXcmY9xcpzhd67LzuS` | `0x799439c8E6cCad5c06b07211c123fb1e2837cf64` |

## Step-by-step (per contract)

1. Open https://nile.tronscan.org/#/contracts/verify in your browser.
2. Fill in the form:

| Field | IDRP value | Controller value |
|---|---|---|
| Contract Address | `TVwWZFGYop7QmdHAUWF219PTC3SUnyYhpb` | `TM44LB4CKmG6n9YNEXcmY9xcpzhd67LzuS` |
| Contract Name | `IDRP` | `IDRPController` |
| Compiler Version | `tron-v0.8.22+commit.5ed3e10f` | same |
| Open Source License | `MIT License (MIT)` | same |
| Optimization | `Yes` | same |
| Runs | `200` | same |
| EVM Version | `paris` | same |

3. **Solidity Contract Code**: paste the entire content of the flattened
   source file from the **dated subfolder**:
   - For IDRP: [`2026-06-09-impl-deploy/IDRP-impl-0xdB10-2D1c.flat.sol`](2026-06-09-impl-deploy/IDRP-impl-0xdB10-2D1c.flat.sol)
   - For Controller: [`2026-06-09-impl-deploy/IDRPController-impl-0x7994-cf64.flat.sol`](2026-06-09-impl-deploy/IDRPController-impl-0x7994-cf64.flat.sol)

   ⚠️ **Make sure you grab the file from this exact subfolder.** Other
   flattened files exist on the `tron` branch (in `flattened/`) that were
   built against OZ v5.6.0 — those use `pragma ^0.8.24` and **will fail**
   verification under tron-solc 0.8.22 with the error
   `"Source file requires different compiler version"`. See
   [`2026-06-09-impl-deploy/BUILD-INFO.md`](2026-06-09-impl-deploy/BUILD-INFO.md)
   for the full provenance and a one-liner to sanity-check pragmas.

4. Solve the reCAPTCHA, click **Verify and Publish**.

5. Wait ~10 seconds. TronScan should report **"Successfully verified"**.

6. If it fails, see the troubleshooting section below.

## Troubleshooting

### "Compiler version error"
TronScan dropdown lists supported compiler versions. The string
`tron-v0.8.22+commit.5ed3e10f` should be in the dropdown. If a slightly
different label is shown (e.g. `0.8.22+commit.5ed3e10f` without the
`tron-` prefix), use whatever the dropdown shows verbatim. **DO NOT type
it manually** — pick from the dropdown.

### `ParserError: Source file requires different compiler version (current compiler is 0.8.22…) … pragma solidity ^0.8.24`
**Cause**: you uploaded the wrong flattened file — probably one from the
`tron` branch's `flattened/` directory (e.g. `IDRP_Flat.sol` with a
capital F). Those were built against OZ v5.6.0 which uses `^0.8.24`
pragmas. tron-solc 0.8.22 can't parse those.

**Fix**: re-upload using the file from the dated subfolder
[`2026-06-09-impl-deploy/`](2026-06-09-impl-deploy/) which was built
against OZ 5.3.0 (only `^0.8.20` and `^0.8.22` pragmas, all compatible).

### "Bytecode does not match"
- Check that `Optimization = Yes` and `Runs = 200`. The deployed
  bytecode used these exact settings (per
  `artifacts-tron/build-info/*.json`: `optimizer.enabled = true`,
  `optimizer.runs = 200`).
- Check `EVM Version = paris`. Even though TVM accepts paris bytecode,
  TronScan may require the literal evmVersion string used at compile
  time. Build-info confirms paris.
- The deployed source had a **TESTNET-LOCAL `UPGRADE_DELAY = 5 minutes`
  override** uncommitted. The flattened source files in this directory
  already include that override. If TronScan rejects the bytecode match,
  double-check the constant value on lines 65 and 93 of the flattened
  files — they should say `5 minutes`, not `48 hours`.

### "Contract already verified"
Win. Click the explorer URL to confirm.

## After verification

Once both impls are verified:

1. Open https://nile.tronscan.org/#/contract/<address> to confirm the
   source-code tab shows the contract code.
2. Mark this complete in `notes/staging/testing/tron-nile-v3-plan-2026-06-09.md`.
3. Wait until 2026-06-11 02:11Z (IDRP) / 02:15Z (Controller) and run the
   `nile-execute-*.ts` scripts to swap the proxies to these now-verified
   impls.

## Why we verify the impl, not the proxy

The proxy contract (the existing `TYdq9k…tv1GU` for IDRP, `TWTji…JWy`
for Controller) is the standard `ERC1967Proxy` — a ~177-byte stub that
delegate-calls to whatever's in the IMPLEMENTATION_SLOT. Its bytecode
never changes. It was verified once at initial deploy and stays verified
forever (TronScan tracks proxy verification independently of the impl
it points at).

When we upgrade, only the **impl** changes (the proxy starts pointing at
a new impl address). Each new impl needs its own verification submission.
The proxy is untouched.

So today's task: **verify just the two impls**. The proxies are already
verified historically.

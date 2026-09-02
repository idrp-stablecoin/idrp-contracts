# Tron mainnet v3 — what this branch is

**Branch:** `mainnet-ready-impl` · **Target:** Tron mainnet only · **Nothing here has been run on mainnet.**

This branch upgrades the Tron `IDRP` token and `IDRPController` from v2 to v3 with
**no role re-grant and no service outage**, by building v3 on **OpenZeppelin 4.9.6**
so that not one storage slot moves.

Commands to run: **[notes/incidents/MAINNET-DEPLOY-AND-SCHEDULE.md](../notes/incidents/MAINNET-DEPLOY-AND-SCHEDULE.md)**
Why it is shaped this way: [notes/incidents/MAINNET-READY-RUNBOOK.md](../notes/incidents/MAINNET-READY-RUNBOOK.md)

---

## ⛔ Tron only. Never deploy this branch to an EVM chain.

The two chain families genuinely diverged, and one `package.json` cannot hold both
OZ majors:

| | storage model | measured |
|---|---|---|
| **Tron mainnet** | OZ 4 — **sequential** | token vars at 504-510, `_paused` at 101 |
| **EVM mainnets** | OZ 5 — **ERC-7201 namespaced** | on Ethereum, `totalSupply()` matches the namespaced slot; OZ 4 slot 53 reads zero |

Deploying these OZ 4 sources onto an EVM proxy would read every variable — balances,
roles, upgrader — from the wrong offset. **That same mismatch in the other direction
is what caused this whole incident:** an OZ 5 implementation, correct for EVM, was
built and scheduled against the OZ 4 Tron proxies. Those two schedules are still
sitting on mainnet and must be cancelled first.

`scripts/utils/assert-oz4-tron-only.ts` enforces this. Every deploy/upgrade script
now calls it and refuses to run OZ 4 against `mainnet`, `polygon`, `bsc`, `kairos`,
`sepolia`, … while allowing `tron`, `nile`, `shasta`, `tre` and local test chains.
**For an EVM chain, use the OZ 5 branch.**

---

## What changed in the contracts

Small and deliberate — five things:

| change | why |
|---|---|
| OZ pinned `5.3.0` → **`4.9.6`** | Tron's deployed proxies use OZ 4 sequential storage |
| `UUPSUpgradeable` → **`TronGaplessUUPSUpgradeable`** (both contracts) | stock OZ 4 UUPS with only the trailing `__gap[50]` removed, **keeping OZ's `immutable __self`**. v3 adds ACDAR (50 slots), so 50 must be given back to keep app variables where they are. It is **not** the storage-slot `TronUUPSUpgradeable` — see below |
| token: `LegacyAccessControlSlots` (`uint256[100]`) | v3 drops `AccessControlUpgradeable` from the token; those 100 slots stay reserved so nothing else lands on them |
| token: `__legacyTailGap` (`uint256[50]`) | puts `frozen` back on slot 504, where the live proxy has it |
| token: `_update` → `_beforeTokenTransfer` | the OZ 4 hook name. Same position in the transfer path |

`UPGRADE_DELAY` stays **48 hours** on both. No testnet override is present.

### Why not the in-house `TronUUPSUpgradeable`

It keeps the proxy address in a **storage slot** rather than a bytecode immutable, and
that slot is written only from `initialize()`. A pre-existing proxy upgraded into it
never runs `initialize()`, so the slot stays zero and **every later upgrade reverts —
permanently**. That is what froze the Nile Controller on 2026-09-02, and both mainnet
proxies are in exactly that shape. `TronGaplessUUPSUpgradeable` keeps the immutable, so
the check lives in bytecode and cannot be left unset. The failure mode is removed, not
worked around.

---

## Evidence

Re-runnable. The first two are read-only against mainnet.

```bash
npx hardhat compile --network tron
npx hardhat run scripts/verify-deployed-source.ts --network tron
npx hardhat run scripts/verify-live-layout.ts     --network tron
npx hardhat test test/upgrade/TronUpgradeRepeatability.ts

docker run -d --name idrp-tre -p 9090:9090 tronbox/tre
npx hardhat run scripts/tvm/make-fixtures.ts
npx hardhat run scripts/tre-mainnet-rehearsal.ts --network tre    # Controller
npx hardhat run scripts/tre-suite.ts             --network tre    # Token
npx hardhat run scripts/tre-tronuups-suite.ts    --network tre    # why not TronUUPS
```

| claim | evidence |
|---|---|
| we know exactly what is deployed | both live implementations are **byte-identical** to `contracts/legacy/IDRPControllerv2.sol` and `contracts/legacy/IDRPv2.sol`, apart from the `immutable __self` placeholder |
| layout does not move | full declared-layout diff, every non-zero slot on both live proxies explained (**0 unexplained**), every slot v3 adds is empty on chain today |
| roles survive | **4/4** in the Controller rehearsal, with no re-grant — and still 4/4 after three upgrades |
| `permit()` survives | `DOMAIN_SEPARATOR` identical before and after, and after three upgrades |
| still upgradeable afterwards | **three** upgrades, TronUUPS slots empty throughout. One further upgrade proves nothing — Nile accepted the upgrade that killed it; the freeze appeared on the *next* one |
| the proxies are healthy today | simulated `upgradeTo` on both live proxies reverts with `"Upgrade not scheduled"` — the UUPS gate passed |

Rehearsals start from the **proven deployed sources**, and abort unless the proxy is in
mainnet's real starting state. Token **25/25**, Controller green, TronUUPS suite **10/10**.

---

## Before scheduling

1. **Cancel the two poisoned schedules.** Controller `41ecf9e211…96aa`, Token
   `0x66acb0ad…3c46`, both executable since July. The Token's is the dangerous one:
   the live implementation still exposes `upgradeTo`, which would succeed and brick
   the contract holding every user balance.
2. **The signer must be the upgrader**, `TQHZ6XmErRcTaBjoWnBwd55sKdoUDfuNn6`. Every
   write is `onlyUpgrader`.
3. **`_legacyDefaultAdminHolders` must be complete.** Confirmed on chain: exactly one,
   `0x9d0a05af0f1fcf33ffa4ec74d3bdbf63e0ff78ba` — which is also the upgrader. Anything
   omitted keeps `DEFAULT_ADMIN_ROLE` after the upgrade. Re-run
   `scripts/tron-list-default-admin-holders.ts` on the day.
4. **Controller first**, observed live, before the Token.
5. **Always `upgradeToAndCall` atomically.** Never `upgradeTo` plus a separate
   initializer — a revert then no longer rolls the implementation swap back. Splitting
   it is what bricked the Nile Controller.

## Known limits

- Nothing has been rehearsed on **Nile** with this build; the Nile Controller is frozen
  from the earlier attempt and cannot be upgraded again.
- `contracts/tvm-fixtures/` is generated test-only material. `IDRPTronUups.sol` and
  `IDRPControllerTronUups.sol` exist **solely** to demonstrate the freeze — never
  deploy them. Regenerate with `scripts/tvm/make-fixtures.ts`; it refuses to emit
  unless its transform is exactly reversible against the real sources.

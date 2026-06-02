# Multisig Validation — Why We Don't Enforce It On-Chain

> Records the deliberate decision (29 May 2026 meeting, refined 2 Jun 2026)
> NOT to enforce a "this address must be a multisig" check on `admin` /
> `upgrader` in the IDRP contracts, and the reasoning so a future audit cycle
> can revisit it on purpose rather than rediscover it.

---

## TL;DR

- We considered adding an on-chain check ("the address being set as `admin` /
  `upgrader` must be a multisig wallet") to defend against accidentally wiring
  authority to a bare EOA.
- **Decision: do not enforce on-chain.** Validate at the operational layer
  (review the address before the tx; the Safe transaction itself proves the
  Safe's quorum signed it).
- Reasoning (next sections): every available primitive proves "a contract" or
  "a smart-contract wallet", **none** proves "a Safe with a sane threshold". The
  check gives false assurance, breaks testing/emergency paths, and doesn't
  generalize across non-EVM chains where IDRP also lives (TRON, eventually
  Solana).

---

## 1. What the available primitives actually prove

| Check                                  | Proves                                       | Fails to prove                       |
|----------------------------------------|----------------------------------------------|--------------------------------------|
| `address.code.length > 0`              | *Some contract* lives at this address.       | It's a Safe. It has a sane threshold. It even has any threshold. |
| ERC-1271 (`isValidSignature` probe)    | This is *a smart-contract wallet* (or anything that implements ERC-1271 — like a custom multi-sig **or** a malicious imitator that accepts every signature). | It's specifically a Safe. The signer set is what we expect. |
| Hard-coded Safe-mastercopy bytecode check | This is *a Safe* (or *was* a Safe — proxies can be retargeted via fallback handlers). | The threshold is > 1. The owners are who we expect. |
| `Safe.getThreshold() > 1` via staticcall | If the address conforms to the Safe ABI and is honest, the threshold is > 1. | It's a Safe at all (any contract can return any value from `getThreshold()`). |

Every primitive is either *too weak* (proves contractness only) or *attackable
by a hostile imitator* (returns whatever values it wants from the probed
calls). And **none** of them proves the operationally meaningful thing: "the
Safe whose owners are the agreed M-of-N signing set".

> A Safe with threshold 1 is a multisig "technically" but is no safer than an
> EOA — the real concern is not "is it a multisig?", it's "does its quorum
> match what governance approved?". That question is an off-chain process
> question, not an on-chain check.

---

## 2. Why enforcement also breaks things we want to keep

- **Tests** deliberately wire `admin` / `upgrader` to EOAs to keep the unit
  suite hermetic and fast. The Safe-wallet test we revive (per the plan) uses
  a real Safe; the rest of the suite shouldn't have to deploy one.
- **Emergency fallback.** If the Safe is ever broken (lost keys, locked
  module, etc.), the off-chain ops process may need to temporarily rotate to
  an EOA. Hardcoded "must be a contract" gating closes that door.
- **Testnet velocity.** Testnet deploys frequently start with an EOA admin
  for iteration speed, only Safe-ing once the flow is proven.

---

## 3. The cross-chain angle (TRON, Solana, future others)

IDRP runs on EVM chains today (ETH, BSC, Polygon, Kaia) **and on TRON**, with
Solana on the roadmap. "Multisig" doesn't generalize cleanly across these:

- **TRON.** Multi-signature support is built into the protocol at the account
  level (you grant permissions with thresholds across signers via
  `TVM.update_account_permissions`). There's no "Safe contract" — the
  account itself has a threshold. A Solidity-level "is this a contract"
  check is **useless** here, because TRON multisig accounts are *not* contract
  accounts; they're regular accounts with non-default permission objects.
- **Solana.** Even further apart — Solana doesn't have EVM-style addresses,
  and the dominant multisig (Squads, Realms) is a *program*-level construct
  whose "address" is a PDA owned by the multisig program. There is no
  equivalent of `address.code.length`.

A pattern that only works on EVM and gives false assurance everywhere else is
worse than no pattern at all — it would let the next chain integration silently
ship a weaker guarantee. So the ops layer is the right place to express "the
authority address is the governance-approved Safe/multisig account", because
that statement *is* portable across chain types: the address is verified,
out-of-band, against the same governance ledger.

---

## 4. What we DO enforce on-chain

We don't try to validate the *kind* of the address, but we do validate
**hygiene** around setting it:

| Check                                | Enforced where                                   |
|--------------------------------------|--------------------------------------------------|
| Non-zero address                     | `setAdmin`, `setUpgrader`, `setController`, `initializeV3` — all `require(addr != address(0))`. |
| `setDepositoryWallet` no-op rejection | SC-06 fix; rejects setting to the current depository to avoid misleading events. |
| Two-step admin rotation (proposed)   | If we adopt ACDAR on the Controller (see [access-control-design.md](./access-control-design.md)), `DEFAULT_ADMIN_ROLE` rotation is `beginDefaultAdminTransfer` → wait per-admin delay → `acceptDefaultAdminTransfer`. The new admin must actively accept; no instant rotation. |
| Frontrun protection on migration     | `initializeV3` gated by `onlyRole(DEFAULT_ADMIN_ROLE)` so an attacker can't seize the new authority slots between upgrade and migration. |

These are what's tractable to express on-chain across chains — they verify
*the protocol*, not *the wallet*.

---

## 5. What the ops process should enforce off-chain

Recorded here so the missing on-chain check is visibly compensated for:

1. **Address review.** The Safe address being set as `admin` / `upgrader` must
   match the governance-approved Safe address in the deployment ledger
   (`deployment/chain-{chainId}.json` plus the runbook). Mismatch = the tx is
   rejected at signing time.
2. **Threshold review.** The Safe's `getThreshold()` and owner set must match
   the agreed governance M-of-N before any rotation is signed.
3. **Test-mode separation.** Local and testnet deploys MAY use EOAs but MUST
   be marked as such in the deployment record; mainnet deploys MUST use a Safe.
4. **Post-migration confirmation.** After `initializeV3` lands on each chain,
   read `admin()` / `upgrader()` back and assert they equal the governance Safe
   address (script: extend `check-contract-state.ts`).

---

## 6. Future revisit conditions

We should re-open this decision if any of these become true:

- A standardized cross-chain wallet-attestation primitive emerges (ERC for
  "this address is a Safe with threshold ≥ N" with verifiable on-chain proof).
- A future audit explicitly demands an on-chain check (then we'd choose
  between ACDAR's two-step rotation, ERC-1271 probing, or hard-coded Safe
  bytecode checks, depending on the threat model the audit specifies).
- We add a new chain whose "multisig" concept is contract-shaped and where
  the check would actually be meaningful (e.g. a future EVM chain with a
  built-in multisig precompile).

---

## 7. Related

- Why the v3 refactor exists at all: [`access-control-design.md`](./access-control-design.md)
- Why `initializeV3` uses `DEFAULT_ADMIN_ROLE` as its gate: [`upgrade-versions-timeline.md`](./upgrade-versions-timeline.md)
- Operational playbook: [`docs/upgrade/UPGRADE.md`](../upgrade/UPGRADE.md)

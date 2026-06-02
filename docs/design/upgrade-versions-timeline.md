# Upgrade Versions & Timeline

> ## ⚠ PARTIAL CORRECTION (2026-06-02)
>
> Section 0 below ("production state at the time of writing") was based on
> probes that used the **wrong selector** for `upgrader()`. The corrected
> per-chain matrix is in
> [`deployed-state-reality.md`](./deployed-state-reality.md).
>
> Short version of the correction: production IS on a **partial v2**
> (`upgrader = 0xb2480DF5…c1779` on all four prod chains). It lacks the
> 48h-timelock state, the sanctions-list, and the post-v2 quorum-role split,
> but the `upgrader` slot itself is populated.
>
> The migration matrix in §3 is still correct in shape (`reinitializer(3)` is
> what it is), but the "production is at v1" labelling needs to read "production
> is at partial-v2."

---

> Authoritative reference for what each `_initialized` version contains, why it
> exists, and what shape the migration takes. Pairs with
> [`docs/upgrade/UPGRADE.md`](../upgrade/UPGRADE.md) (operational playbook) and
> [`docs/upgrade-history/UPGRADE_HISTORY.md`](../upgrade-history/UPGRADE_HISTORY.md)
> (per-chain tx log).

---

## Production state at the time of writing (verified 2026-06-02)

Direct RPC probes against the live proxies confirmed the deployed implementation
state on **Ethereum (1), Polygon (137), Kaia (8217)** is identical and is **far
behind `main`**:

| Surface (IDRP)                  | Production | Note                                          |
|---------------------------------|:----------:|-----------------------------------------------|
| `depositoryWallet()`            | ✅         | Dec-2025 burn-fix landed                      |
| `MINTER_ROLE()` / `PAUSER_ROLE` / `FREEZER_ROLE` | ✅ | v1 role surface still active          |
| `maxSupply()`                   | ✅         | returns 0 (unlimited)                         |
| `upgrader()`                    | ❌ reverts | v2 (single-upgrader + 48h timelock) not deployed |
| `controller()`                  | ❌ reverts | v3 single-entity model not deployed           |
| `admin()`                       | ❌ reverts | v3 single-entity model not deployed           |
| `sanctionsList()`               | ❌ reverts | sanctions-list addition not deployed          |

| Surface (Controller)            | Production | Note                                          |
|---------------------------------|:----------:|-----------------------------------------------|
| `idrpToken()`                   | ✅         | wired                                         |
| `nonce()`                       | ✅         | returns e.g. ETH=6, Polygon=5094, Kaia=2524 — replay protection is still nonce-based |
| `ADMIN_ROLE()`                  | ✅         | v1 ADMIN_ROLE still active                    |
| `OFFICER_ROLE()` / MANAGER / DIRECTOR / COMMISSIONER | ❌ reverts | quorum-role split not deployed |
| `upgrader()` / `owner()` / `admin()` | ❌ reverts | v2/v3 authority model not deployed       |

The deployed Controller still uses the older `nonce`-based replay model — it
predates the `usedSignatures[hash]` + `operationIdentifier` design that's in
`main` today.

**Translation:** production proxies are at `_initialized == 1` and the deployed
implementations expose roughly the surface of "v1 + the Dec-2025 burn fix" and
nothing else from the subsequent audit/refactor work.

---

## Version definitions

These are the versions that have **ever existed in source** (not necessarily
deployed). Each row tells you which OZ `_initialized` counter value corresponds
to it and which initializer mutates state when transitioning into it.

| Version | `_initialized` | Source state | Authority model | Replay protection | Deployed to prod? |
|---------|:--------------:|---|---|---|:---:|
| **v1**  | `1` | Initial public deploy. `AccessControlUpgradeable`, role-based authority. `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, `PAUSER_ROLE`, `FREEZER_ROLE` (IDRP). `DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, plus a single `nonce` (Controller). | Role-based; one super-admin (Safe) can grant everything. | Controller: monotonic `nonce`. | ✅ Yes (plus Dec-2025 burn-logic upgrade that kept `_initialized == 1`). |
| **v2**  | `2` | 042026 audit remediation: introduces single-address `upgrader` slot + 48h timelock on both contracts. `initializeV2` migrates v1 proxies into the new model. Controller refactored to OFFICER/MANAGER/DIRECTOR/COMMISSIONER quorum roles + `usedSignatures[hash]` + `operationIdentifier`. | Roles for quorum signers; `upgrader` is a single Safe; `DEFAULT_ADMIN_ROLE` still admin of the four signer roles. | Controller: `usedSignatures[bytes32]` keyed by EIP-712 op hash (incl. `operationIdentifier`). | ❌ Never deployed to a production chain. |
| **v3**  | `3` | This refactor. Removes `AccessControlUpgradeable` from IDRP entirely (Option I interim retains it only as the `initializeV3` gate; the final IDRP impl drops it). Controller keeps `AccessControlUpgradeable` only for the four signer roles. Both contracts collapse admin authority to a single `admin` slot (or `DEFAULT_ADMIN_ROLE` under ACDAR — see [access-control-design.md](./access-control-design.md)). | Single named slots: `admin`, `controller` (IDRP only), `upgrader`. Plus the four quorum-signer roles on the Controller. | Unchanged from v2. | Not yet — this is the migration in progress. |

### Within v3: the IDRP two-step

For IDRP only (per `plan §3` / Option I), v3 actually arrives in two
implementations to safely cross the AccessControl removal:

- **v3 interim impl** — still inherits `AccessControlUpgradeable`. `initializeV3`
  is gated by `onlyRole(DEFAULT_ADMIN_ROLE)` (the only authority that exists on
  prod). Sets `admin`, `controller`, `upgrader` in one atomic tx.
- **v3 final impl** — no `AccessControlUpgradeable` import at all. No initializer
  (the storage was set in interim). Just a normal `upgradeToAndCall(finalImpl, "0x")`
  after the 48h timelock.

The Controller does **not** need a two-step — it keeps `AccessControlUpgradeable`
permanently (for the signer roles), so its v3 lands in a single impl.

---

## The migration matrix

Every live proxy must reach v3. The path depends on its current `_initialized`
value. OZ's `reinitializer(n)` requires `_initialized < n` and sets it to `n` —
**it does NOT replay earlier versions**. A proxy can jump straight from v1 to v3.

| Current state              | Path to v3                                              | Why                                                  |
|----------------------------|---------------------------------------------------------|------------------------------------------------------|
| Fresh deploy (no proxy)    | Deploy v3 directly via `initialize`.                    | `initialize` is the v1 entry point but writes v3 state in the v3 source. `_initialized` becomes `1`; a follow-up call to `initializeV3` is **not** needed for fresh deploys. |
| `_initialized == 1` (prod)| Upgrade to v3 impl, call `initializeV3(...)` in same tx (`upgradeToAndCall`). | Production reality on Ethereum/Polygon/Kaia. v2 was never deployed; v3 reinitializer accepts the jump. |
| `_initialized == 2`        | Upgrade to v3 impl, call `initializeV3(...)` in same tx. | Testnet proxies might be here. Same flow as `==1`.   |
| `_initialized == 3`        | Already done — no migration tx.                          | Idempotent: a second `initializeV3` reverts (`InvalidInitialization`). |

For the IDRP two-step specifically:
1. Upgrade to **interim v3 impl** + call `initializeV3` (timelocked, 48h on mainnet).
2. Wait 48h, then upgrade to **final v3 impl** (no initializer).
3. `_initialized` ends at `3` after step 1; step 2 does not touch it.

---

## Why `initializeV3` is gated by `DEFAULT_ADMIN_ROLE`

This is the single most-asked question about the migration. The short answer:
**it is the only authority that exists on every production chain today.**

- Production proxies have `upgrader() == address(0)` (v2 was never deployed), so
  gating by `onlyUpgrader` would be **unrunnable**.
- Production proxies have `owner() == 0` / revert (v2 dropped Ownable on the
  Controller), so `onlyOwner` is also out.
- `DEFAULT_ADMIN_ROLE` IS held on every production chain (granted in `initialize`
  to the Safe address). So it is the only universal pre-existing handle.

Using `DEFAULT_ADMIN_ROLE` as the migration gate is **also frontrun-safe**: only
the Safe holds it, and an attacker would need to compromise the Safe quorum to
beat us to the call. Same protection as the existing 042026-audit `initializeV2`
gate (MINOR-1/MINOR-2 findings).

After `initializeV3` runs:
- IDRP interim: `DEFAULT_ADMIN_ROLE` is no longer read by any production path
  (every method is now `onlyAdmin`/`onlyController`/`onlyUpgrader`). It is
  dead in the bytecode, harmless. The final IDRP impl removes the role entirely.
- Controller: `DEFAULT_ADMIN_ROLE` continues to be read **only by `initializeV4`
  if we ever add one**. The overridden `grantRole`/`revokeRole` bypass the
  role-admin machinery, so the role can no longer grant or revoke any other role.

---

## Timeline

```
v1 source              v2 source                            v3 source
(audit v3.x)           (042026 audit remediation, May 2025)   (052026 audit + no-access-control)
   │                          │                                       │
   ├─ Mar 2025: Polygon prod  │                                       │
   ├─ Aug 2025: ETH mainnet   │                                       │
   ├─ Oct 2025: BSC, Kaia     │                                       │
   ├─ Dec 2025: burn-fix      │                                       │
   │   (still _initialized=1) │                                       │
   │                          │                                       │
   │                          │── never deployed to prod ──┐          │
   │                          │   (testnets may differ)    │          │
   │                          │                            │          │
   │                          │                            ▼          │
   │                          │                                       │── target migration:
   │                          │                                       │   prod jumps v1 → v3
   │                          │                                       │   (skipping v2 entirely)
   │                          │                                       │
   ▼                          ▼                                       ▼
 _initialized=1           _initialized=2                          _initialized=3
 (prod is here today)     (testnets only — if any)                (target)
```

---

## Cross-references

- Plan & rationale: [`notes/features/idrp-contracts/on-progress/no-access-control/plan.md`](../../../../notes/features/idrp-contracts/on-progress/no-access-control/plan.md)
- ACDAR vs custom-`admin` decision: [`access-control-design.md`](./access-control-design.md)
- Multisig validation (the deferred check): [`multisig-validation.md`](./multisig-validation.md)
- Operational playbook (commands): [`docs/upgrade/UPGRADE.md`](../upgrade/UPGRADE.md)
- Per-chain tx log: [`docs/upgrade-history/UPGRADE_HISTORY.md`](../upgrade-history/UPGRADE_HISTORY.md)

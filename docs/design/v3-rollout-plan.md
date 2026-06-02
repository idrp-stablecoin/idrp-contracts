# v3 Rollout — Path A + Legacy Contracts + State-Snapshot

> **Final status:** Path A. The v3 `contracts/IDRP.sol` drops
> `AccessControlUpgradeable` from inheritance entirely, preserving the
> ERC-7201 storage namespace via a deprecated struct (same trick as the
> existing `OwnableStorageDeprecated` on the Controller). The v1→v2
> migration that two testnets still need lives in `contracts/legacy/IDRPv2.sol`,
> deployed by `scripts/v1-to-v2/`.
>
> Date: 2026-06-02. Branch: `access-controll`.
>
> This doc preserves the full brainstorm — including the **Path B intermediate
> decision** we held briefly and the corrections that came after — so anyone
> reading the history can see why Path A won.

---

## 1. The brainstorm in one page

### Question
Should the FINAL v3 IDRP impl drop `AccessControlUpgradeable` from its
inheritance, given we've already collapsed every gate to `onlyAdmin` /
`onlyController` / `onlyUpgrader`?

### What we considered
- **Path A — Two contracts.** `IDRPInterim` (with AccessControl) + `IDRP`
  (without). Mainnet: v2 → IDRP. Testnets at v1: v1 → IDRPInterim → IDRP.
  Cleanest end-state, but two contracts to maintain and a new way to be wrong.
- **Path B — Keep AccessControl inherited but unused.** Bytecode keeps the
  role machinery, but ZERO methods use `onlyRole`. Auditor ask is satisfied
  (no role-gated operational/config methods) without a storage-layout risk.
- **Path C — Drop AccessControl AND keep `initializeV2` with a different
  gate.** No clean gate available (hardcoded address is ugly, `msg.sender ==
  address(0)` is impossible). Rejected.

### What pushed us to Path B (the safety story)

The OZ docs we re-read explicitly warn:
> *"You may also be inadvertently changing the storage variables of your
> contract by changing its parent contracts."*

The plugin DOES auto-detect ERC-7201 namespaces and validate per-namespace
changes, but:
> *"removing a parent that uses ERC-7201 namespaced storage"* is **not**
> explicitly blessed as safe in the OZ docs.

For IDRP — a regulated stablecoin already on 4 mainnets — a bad storage
upgrade is essentially unrecoverable (see §3 below). The cost-benefit is
clear: take the bytecode-bloat hit, keep the parent, ship safely.

### Initial decision: Path B (LATER REVISITED — see below)

We initially chose Path B and the code briefly reflected it. Then we
empirically tested whether the `OwnableStorageDeprecated` pattern would
work for `AccessControl` too, and found that **it does** — so the storage
argument that pushed us toward Path B was actually weaker than we'd
believed. We flipped to Path A.

### Final decision: Path A

- **`contracts/IDRP.sol`** — drop `AccessControlUpgradeable` from inheritance.
  Preserve the namespace via a `struct AccessControlStorageDeprecated` with
  the `@custom:storage-location erc7201:openzeppelin.storage.AccessControl`
  annotation. No `__AccessControl_init`, no `_grantRole`, no `initializeV2`,
  no `onlyRole` anywhere. `initialize` simply writes `admin = upgrader =
  superAdmin`. End-state is a clean three-slot authority model with zero
  role machinery in the v3 bytecode.

- **`contracts/legacy/IDRPv2.sol` + `IDRPControllerv2.sol`** — byte-for-byte
  preserved copies of the verified mainnet v2 implementations. Renamed only
  to avoid namespace collisions with the v3 contracts:
    - `IDRP` → `IDRPv2`, `ISanctionsList` → `ISanctionsListLegacy`
    - `IDRPController` → `IDRPControllerv2`, `IIDRP` → `IIDRPLegacy`
  These exist solely so `scripts/v1-to-v2/` can deploy them onto the two
  testnets still stuck at v1 (Kaia Kairos IDRP and Base Sepolia Controller).
  Once those reach v2, they migrate to v3 via the same production path as
  every mainnet.

- **`scripts/v1-to-v2/`** — testnet-only migration folder. Deploys
  `legacy/IDRPv2.sol` / `legacy/IDRPControllerv2.sol`, runs `initializeV2`
  to populate the `upgrader` slot. After this step the testnet looks like
  production v2 and can run the v3 migration via the normal `scripts/`.

- **`scripts/`** (existing top-level) — reused for v2→v3. The current
  `scripts/upgrade.ts` etc. naturally become the v3 deploy path once this
  branch lands on `main`.

- **`deployment/state-snapshot/`** — per-chain registry of proxy address,
  current implementation, version derived from surface probes, and migration
  history. JSON files + probe scripts + README.

### Important correction to the storage argument (added 2026-06-02)

The original write-up of this brainstorm leaned heavily on "storage
corruption is unrecoverable" to motivate Path B. After a direct
empirical test (sandbox IDRP that drops `AccessControlUpgradeable` and
preserves the namespace via `struct AccessControlStorageDeprecated`),
**`hre.upgrades.validateUpgrade` accepts the upgrade**. The
`OwnableStorageDeprecated` trick we already used on the Controller IS
portable to `AccessControl`. So Path A is NOT blocked by a storage-layout
concern.

The real blocker for Path A is more mundane: **`initializeV2` (the v1→v2
migration that two testnets still need) is gated by
`onlyRole(DEFAULT_ADMIN_ROLE)`**. Drop the parent, drop the role machinery,
drop the gate. The only authority that exists on a v1 chain is the
role-based one — so Path A forces testnets to go through an interim impl
that still has AccessControl just for the migration.

The cost-benefit therefore is:
- **Path B** — one impl, all chains migrate through it, slight bytecode
  bloat. Auditor sees `AccessControlUpgradeable` in inheritance but zero
  `onlyRole` use anywhere except the migration entry. Risk: nothing
  material.
- **Path A** — two impls (interim with AccessControl just for v1→v2, final
  without), or just decommission the testnets at v1 and accept that any
  future v1 deploy can't easily migrate. Cleaner end-state, more moving
  parts.

For v3, Path B remains the better trade. **Path A becomes viable for a
future v4 once all chains are at v3 and the v1→v2 question is moot.**

---

## 2. Live state of all our chains (verified 2026-06-02)

Per direct RPC probes with the CORRECT selectors (`upgrader()` is
`0xaf269745`, not `0xf72c0d8b`):

### Production (4 chains)
| Chain | IDRP `upgrader()` | CTRL `upgrader()` | Verdict |
|---|---|---|---|
| Ethereum (1)  | ✅ `0xb2480DF5…c1779` | ✅ `0xb2480DF5…c1779` | both v2 |
| Polygon (137) | ✅ `0xb2480DF5…c1779` | ✅ `0xb2480DF5…c1779` | both v2 |
| BSC (56)      | ✅ `0xb2480DF5…c1779` | ✅ `0xb2480DF5…c1779` | both v2 |
| Kaia (8217)   | ✅ `0xb2480DF5…c1779` | ✅ `0xb2480DF5…c1779` | both v2 |
| Tron mainnet  | (assumed v2; verify before rollout) | — | TBD |

### Testnets we operate (3 chains)
| Chain | IDRP `upgrader()` | CTRL `upgrader()` | Required pre-v3 work |
|---|---|---|---|
| Base Sepolia (84532)  | ✅ (testnet upgrader set) | ❌ REVERT      | Run v1→v2 on CTRL |
| Kaia Kairos (1001)    | ❌ REVERT                 | ✅ (testnet upgrader set) | Run v1→v2 on IDRP |
| Tron Nile             | (probe via TronWeb)              | (probe via TronWeb) | TBD |

So **two testnet chains need a v1→v2 migration** before we can run the v3
migration on them. That's why we need `scripts/v1-to-v2/`.

### Testnets that aren't relevant
Sepolia, Holesky, Holesky-2 — we don't operate on these in production
ops; leave alone or decommission separately. Listed in state-snapshot for
completeness but no migration planned.

---

## 3. Storage corruption deep-dive (general context)

This explains in detail what would happen if a storage-incompatible upgrade
landed. It's the *general* reason OZ added namespaced storage in v5 and the
reason we never use `unsafeSkipStorageCheck`.

> NOTE — earlier drafts of this doc used this section as the load-bearing
> argument for Path B. That was wrong. The actual blocker for Path A is the
> v1→v2 migration gate, not storage safety (see §1 "Important correction"
> for the corrected framing). The storage-corruption material below is still
> useful background — it's why we ALWAYS run `validateUpgrade` before any
> migration and why we NEVER pass `unsafeSkipStorageCheck`.

### How storage works in UUPS
- The proxy holds **state** at deterministic slot addresses.
- The implementation contract holds **code** that knows where each variable
  lives in storage.
- `upgrade` swaps the impl pointer. The state slots stay; the new code reads
  them according to its own variable map.
- If the maps don't align, the new code reads the wrong slots — corruption.

### What "incompatible" looks like
- An old `uint256 totalSupply` slot becomes a new `address depositoryWallet`
  slot. `totalSupply()` returns garbage. Transfers compute against junk.
- An old `mapping(address => uint256) balances` slot becomes a `bool paused`.
  Every user's balance is now read as 0 or 1.
- The freezer check reads from a slot that used to hold `maxSupply` — random
  accounts become "frozen" or not.

### Can you fix it with another upgrade?

The honest answer for IDRP: **not really**. Three blockers:

1. **You might not have upgrade authority anymore.** UUPS authority lives in
   the impl. If `_authorizeUpgrade` checks `msg.sender == upgrader`, and
   `upgrader` now reads from a corrupted slot, the comparison fails for
   every real signer. The proxy is bricked.

2. **You can't read what's where.** Tools like `eth_getStorageAt` work, but
   reconstructing "this slot was `balances[alice]` before the bad upgrade"
   for millions of holders requires forensic event-replay. Massive cost,
   slow, error-prone.

3. **Data may already be overwritten.** Even if you deploy a corrected
   impl, the corrupting `SSTORE`s that happened between bad-upgrade and
   rescue have permanently overwritten the original values. The new impl
   reads the same overwritten slots.

### Pseudo-escapes that don't work in practice

- *"`eth_setStorageAt` to rewrite slots."* Hardhat/Anvil RPC only — not a
  real-chain method. Can't do it on Ethereum mainnet.
- *"Deploy new proxy, migrate users."* For a token integrated with bridges,
  CEXes, DEXes, wallets — that's effectively issuing a new asset. Off-ramp
  flows break. Liquidity fragments. The regulatory invariant "on-chain
  supply matches reserves" breaks for the duration of the migration.

### Why this matters for IDRP specifically
IDRP is a regulated stablecoin where OJK + auditors require on-chain state
to always match off-chain reserves. A storage corruption is not just a
"redeploy and apologize" event — it's a regulatory incident.

So: **OZ's storage check is the wall we don't cross**. We design every
migration to pass it cleanly. We never use `unsafeSkipStorageCheck`. We
always run `validateUpgrade` before any `upgradeProxy`.

---

## 4. The Path A implementation in one block

What the final v3 IDRP looks like (drops `AccessControlUpgradeable`,
preserves namespace via deprecated struct):

```solidity
contract IDRP is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    // AccessControlUpgradeable removed — namespace preserved below.
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    /// @custom:storage-location erc7201:openzeppelin.storage.AccessControl
    struct AccessControlStorageDeprecated {
        mapping(bytes32 role => RoleDataDeprecated) _roles;
    }
    struct RoleDataDeprecated {
        mapping(address => bool) hasRole;
        bytes32 adminRole;
    }
    // DO NOT REMOVE. Holds legacy role-membership data from v1/v2.
    // No method in v3 reads it. If a future version re-inherits
    // AccessControlUpgradeable, audit the existing entries first.

    // v3 authority slots:
    address public admin;
    address public controller;
    address public upgrader;

    // Operational methods gate on `onlyController`:
    function mint(uint256 amount)               public onlyController whenNotPaused { … }
    function burn(address from, uint256 amount) public onlyController whenNotPaused { … }
    function pause()   public onlyController { … }
    function unpause() public onlyController { … }
    function freeze(address account)   external onlyController { … }
    function unfreeze(address account) external onlyController { … }

    // Config methods gate on `onlyAdmin`:
    function setMaxSupply(uint256)        external onlyAdmin { … }
    function setDepositoryWallet(address) external onlyAdmin { … }
    function setSanctionsList(address)    external onlyAdmin { … }
    function setController(address)       external onlyAdmin { … }
    function setAdmin(address)            external onlyAdmin { … }
    function setUpgrader(address)         external onlyAdmin { … }
    function withdrawToken(...)           external onlyAdmin { … }

    // Upgrade authority gates on `onlyUpgrader`:
    function scheduleUpgrade(address)   external onlyUpgrader { … }
    function cancelUpgrade()            external onlyUpgrader { … }
    function _authorizeUpgrade(address) internal override onlyUpgrader { … }

    // ONLY two initializers in v3:
    function initialize(address superAdmin) public initializer { … }    // fresh deploy
    function initializeV3(address _admin, address _controller, address _upgrader)
        external reinitializer(3) onlyUpgrader { … }                    // v2 → v3 path
    // initializeV2 is GONE from v3. v1 → v2 happens via legacy/IDRPv2.sol.
}
```

### What's NOT in this contract
- `AccessControlUpgradeable` in the inheritance list
- `DEFAULT_ADMIN_ROLE` (or any role) as a callable gate
- `grantRole`, `revokeRole`, `hasRole`, `renounceRole` — all gone from ABI
- `initializeV2` — lives in `contracts/legacy/IDRPv2.sol` instead

### Why this satisfies the auditor ask
The auditor asked: *"don't gate operational and config methods on roles."*
We don't. We went further and removed the role machinery from the bytecode
entirely. The OZ Upgrades plugin accepts the v2→v3 upgrade (verified via
`validateUpgrade`) because the storage namespace declaration preserves the
ERC-7201 slot mapping that already exists on production proxies.

### The IDRPController is different
The Controller uses `AccessControlDefaultAdminRulesUpgradeable` (ACDAR),
which extends `AccessControlUpgradeable`. That's intentional: the Controller
has FOUR roles with multiple holders each (OFFICER/MANAGER/DIRECTOR/
COMMISSIONER quorum signers) plus a single `DEFAULT_ADMIN_ROLE` managed
through ACDAR's two-step delayed flow. The Controller could NOT collapse
to single-address slots because the signer roles are inherently
multi-holder. See [`access-control-design.md`](./access-control-design.md).

---

## 5. The state-snapshot registry

> Lives at `deployment/state-snapshot/`. The folder is the answer to your
> question *"how do we always know what version each chain is on?"*

### Structure

```
deployment/state-snapshot/
├── README.md                          # explains the folder, format, how to update
├── chains/
│   ├── chain-1.json                   # Ethereum mainnet — current state
│   ├── chain-56.json                  # BSC mainnet
│   ├── chain-137.json                 # Polygon mainnet
│   ├── chain-8217.json                # Kaia mainnet
│   ├── chain-tron.json                # Tron mainnet
│   ├── chain-84532.json               # Base Sepolia
│   ├── chain-1001.json                # Kaia Kairos
│   └── chain-tron-nile.json           # Tron Nile
└── scripts/
    ├── probe-chain.ts                 # one-chain RPC probe → JSON refresh
    └── probe-all.ts                   # runs probe-chain across all configured chains
```

### What each `chain-{id}.json` contains

```jsonc
{
  "chainId": 1,
  "chainName": "Ethereum",
  "rpcUrl": "<configurable; not committed if API-keyed>",
  "snapshotTakenAt": "2026-06-02T10:00:00Z",
  "snapshotTakenBy": "probe-all.ts",

  "idrp": {
    "proxyAddress": "0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56",
    "currentImpl": "0xbb3ba3fa…3f42a",
    "version": "v2",                         // derived from probe results
    "surfaces": {
      "upgrader()": "0xb2480DF5…c1779",      // OK = populated
      "UPGRADE_DELAY()": "REVERT",           // ← partial v2 (early draft)
      "admin()": "REVERT",                   // not v3
      "controller()": "REVERT",              // not v3
      "depositoryWallet()": "0x5a84ce5d…ab50d3",
      "sanctionsList()": "REVERT"
    }
  },

  "controller": {
    "proxyAddress": "0x9cB9AE7480ee98A41373100d4304194043f02c9d",
    "currentImpl": "0xafa2d94f…65ebb",
    "version": "v2",
    "surfaces": {
      "upgrader()": "0xb2480DF5…c1779",
      "OFFICER_ROLE()": "OK <hash>",         // v1-or-v2 quorum-role surface
      "ADMIN_ROLE()": "OK <hash>",
      "admin()": "REVERT",
      "defaultAdmin()": "REVERT"             // not ACDAR yet
    }
  },

  "migrationsApplied": [
    { "version": "v1", "txHash": "0xf6cca1fb…", "date": "2025-08-26T11:03:35Z" },
    { "version": "v2", "txHash": "TBD",        "date": "TBD-need-event-replay" }
  ],
  "migrationsPending": ["v3"]
}
```

### Why this format
- **Per-chain JSON** so each chain has one source of truth that's easy to
  diff, commit, and read at a glance.
- **`surfaces` object** captures the actual probe results — the same shape
  for every chain — so we can tell at a glance which functions exist.
- **`version`** is derived from the surfaces; the README explains the
  derivation rules so different operators agree.
- **`migrationsApplied`** is the on-chain history; backfilled from the
  existing `UPGRADE_HISTORY.md`.

### Scripts

- `scripts/probe-chain.ts <chainId>` — hits the chain via Hardhat RPC,
  fills in surfaces, writes the chain-{id}.json.
- `scripts/probe-all.ts` — loops over all configured chains, refreshes
  every snapshot. Run before any migration.

---

## 6. The migration script structure

### `scripts/v1-to-v2/` (NEW, this branch)

For the two testnets stuck at v1. Deploys `contracts/legacy/IDRPv2.sol` /
`IDRPControllerv2.sol` and runs the historical `initializeV2` migration so
the testnet's `upgrader` slot is populated. After this step the testnet
looks like every production chain (partial-v2 with `upgrader` set) and can
be migrated to v3 via the normal `scripts/` flow.

```
scripts/v1-to-v2/
├── README.md                          # ops playbook + per-chain checklist
├── validate.ts                        # validateUpgrade(proxy, IDRPv2) — must pass before any other step
├── prepare-upgrade.ts                 # deploys legacy/IDRPv2 impl on the target chain; outputs address
├── prepare-upgrade-controller.ts      # same for legacy/IDRPControllerv2
├── upgrade.ts                         # upgradeToAndCall(newV2Impl, initializeV2(safe, legacyHolders))
├── upgrade-controller.ts              # upgradeToAndCall(newV2Impl, initializeV2(safe))
└── list-legacy-upgrader-holders.ts    # already exists at scripts/list-upgrader-holders.ts; reuse
```

### `scripts/` (existing top-level)

For v2 → v3 — every chain. No new folder needed: the existing
`scripts/upgrade.ts` / `prepare-upgrade-impl.ts` / `schedule-upgrade.ts`
become the v3 deploy path automatically once this branch lands on `main`
(because the source they target IS v3 then).

What changes vs the v2 versions of these scripts:
- The `upgrade.ts` execute step calls `initializeV3(admin, controller,
  upgrader)` on IDRP and `initializeV3(admin, upgrader,
  legacyDefaultAdminHolders)` on the Controller (with the ACDAR
  revoke-then-init ordering).
- A new `scripts/list-default-admin-holders.ts` enumerates DEFAULT_ADMIN_ROLE
  holders via RoleGranted/RoleRevoked event replay — needed for the
  Controller's v3 migration to pass the array.
- The pre-upgrade snapshot refresh writes
  `deployment/state-snapshot/chains/chain-{id}.json` so we have a
  versioned record of the pre-migration state.

### A future `scripts/v3-to-v4/` (HYPOTHETICAL)

When v4 happens, we'd add `scripts/v3-to-v4/` for the migration, mirroring
the `v1-to-v2` pattern. Plus a `contracts/legacy/IDRPv3.sol` copy so any
chain stuck at v3 can be brought forward. Same pattern as today; no
architectural change.

### Pre-condition checks every migration script runs

Before any state-changing call:

1. **`validateUpgrade(proxy, newFactory)`** — OZ-plugin layout check. Fails
   loudly if anything is incompatible. NO `unsafeSkipStorageCheck` ever.
2. **Surface probe** — call `upgrader()` (and `admin()`, `controller()`,
   etc. as relevant) and confirm the source-version assumption.
3. **`snapshotTakenAt`** — refresh `deployment/state-snapshot/chains/chain-{id}.json`
   before the migration tx so we have a pre-migration record.
4. **Signer check** — confirm `msg.sender` matches the on-chain
   `upgrader()` value. If not, abort with a clear error.

Each script logs each step and refuses to proceed past a failure.

### Testnet `UPGRADE_DELAY` workaround

You mentioned testnet timelock should be 5 min so testing is feasible. Two
options:

- **Option a — env-gated constant.** Add `UPGRADE_DELAY = block.chainid ==
  N ? 5 minutes : 48 hours` in source. Ugly; lives in bytecode.
- **Option b — separate testnet impl.** A `IDRPTestnetTimelock` contract
  identical to `IDRP` except `UPGRADE_DELAY = 5 minutes`. Deploy this on
  testnets only.
- **Option c — script-level "wait" override.** Keep contract at 48h, but
  the `upgrade.ts` script reads `UPGRADE_DELAY` from chain and respects it.
  For testnet, manually edit the constant uncommitted, deploy, redeploy
  with proper constant for mainnet.

You said "not committed; temp 5 min for testing" — that matches **Option c**
(uncommitted local edit). Documenting it in the v1-to-v2 README so future
ops know to override only for testnets, then revert before mainnet deploy.

---

## 7. Your specific questions, answered

### Q1: "Can `validateUpgrade` confirm safety? Should we call it as additional safety?"

**Yes — make it mandatory in every migration script.** Per OZ docs, it does
exactly the same storage-layout check that `upgradeProxy` does internally,
but without deploying. So calling it as a pre-flight check is free
insurance. Every script in `scripts/v1-to-v2/` and the top-level `scripts/`
(v2→v3) calls it first; abort on failure.

### Q2: "Why is storage corruption catastrophic?"
Answered in §3. Short version: not recoverable for a stablecoin already on
4 mainnets. We never use `unsafeSkipStorageCheck`, regardless of how
clean an upgrade looks.

### Q3: "Can a v1 testnet skip straight to v3 via initializeV3?"

**No — and the contract's gating makes the failure safe.** `initializeV3` is
gated by `onlyUpgrader`. A v1 proxy has `upgrader == address(0)` (the slot
doesn't exist as a populated value). So:

```
upgradeToAndCall(v3Impl, initializeV3(admin, ctrl, upgrader))
  → impl switches to v3
  → initializeV3 body runs
  → onlyUpgrader modifier: msg.sender == 0?  NO → REVERT
  → entire upgradeToAndCall reverts
  → proxy stays on v1
```

So **the upgrade tx fails cleanly** — no half-state, no corruption. The
proxy is unchanged after the failed tx. We must run v1→v2 first on those
testnets, then v2→v3.

You said:
> "the only thing we fear is: we upgrade v3 but upgrader not there right?
> so upgrade wont happen, since initializeV3 is only called by upgrader,
> this should be clean and dont break anything since it should be revert
> if theres no upgrader or actor that calls script is not upgrader right?"

**Yes — you're correct.** This is exactly how `onlyUpgrader` + the atomic
`upgradeToAndCall` are designed. The `_authorizeUpgrade` check on the OLD
impl runs first (so v1's `onlyRole(UPGRADER_ROLE)` must succeed for the
proxy to swap impls), THEN the new impl's initializer runs. If the
initializer reverts, the entire tx reverts — including the impl swap. The
proxy never actually moves to v3.

This is the **clean failure mode** that lets us safely attempt the upgrade
without risking a stuck proxy.

---

## 8. The actual rollout order

### Phase 1 — testnet remediation (this week)
1. ✅ Run v1→v2 on Base Sepolia CTRL (currently REVERT on upgrader).
2. ✅ Run v1→v2 on Kaia Kairos IDRP (currently REVERT on upgrader).
3. ✅ Verify all 3 testnets (Base Sepolia, Kairos, Tron Nile) have
      `upgrader` populated on both IDRP and Controller.

### Phase 2 — testnet v3 (testing the full migration)
4. ✅ Run v2→v3 on Base Sepolia (with `UPGRADE_DELAY` set to 5 min in the
      uncommitted impl).
5. ✅ Same on Kairos.
6. ✅ Same on Tron Nile (TRON-specific tooling).
7. ✅ Smoke-test for a week: confirm `executeOperation`, `mint`, `burn`,
      role rotation, etc. all work end-to-end.

### Phase 3 — mainnet v3 (after testnet soak)
8. ✅ Run v2→v3 on Polygon (lowest-stake mainnet).
9. ✅ Same on BSC, Kaia.
10. ✅ Same on Ethereum (highest-stake; last).
11. ✅ Same on Tron mainnet.

### Phase 4 — cleanup
12. Update `deployment/state-snapshot/` for all chains.
13. Update `UPGRADE_HISTORY.md`.
14. Decommission `scripts/v1-to-v2/` (no longer needed) or archive.

---

## 9. What's NOT in scope for this v3

- Dropping `AccessControlUpgradeable` from IDRP (Path A). Defer to a future
  v4 with full storage-preservation tests on every chain.
- Migrating Tron-specific tooling (separate concern; the TRON multisig
  doc captures what's different there).
- Changing the `UPGRADE_DELAY` permanently. Stays at 48h on mainnet.
- Adding new operational features (mint cap changes, additional roles,
  etc.). v3 is a security-shape refactor only.

---

## 10. Related docs

- [`deployed-state-reality.md`](./deployed-state-reality.md) — chain-by-chain probe results (will be partially superseded by `deployment/state-snapshot/`)
- [`upgrade-versions-timeline.md`](./upgrade-versions-timeline.md) — version definitions
- [`initializeV3-gating.md`](./initializeV3-gating.md) — why `onlyUpgrader` (with the SUPERSEDED banner)
- [`access-control-design.md`](./access-control-design.md) — ACDAR decision for Controller
- [`no-defaultadmin-leftbehind.md`](./no-defaultadmin-leftbehind.md) — the dual-holder fix
- [`acdar-migration-and-tron-multisig-gotchas.md`](./acdar-migration-and-tron-multisig-gotchas.md) — both gotchas in one place
- [`multisig-validation.md`](./multisig-validation.md) — why we don't enforce multisig on-chain
- [`../upgrade/UPGRADE.md`](../upgrade/UPGRADE.md) — legacy v1→v2 operational playbook
- [`../upgrade-history/UPGRADE_HISTORY.md`](../upgrade-history/UPGRADE_HISTORY.md) — per-chain tx log (needs the missing v2 rows backfilled)

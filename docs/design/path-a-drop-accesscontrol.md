# Path A — Dropping `AccessControlUpgradeable` from IDRP

> Records the technical pattern used to remove `AccessControlUpgradeable`
> from the v3 IDRP impl while preserving v2 storage. Covers the
> dead-namespace warning that future devs / auditors will see, the OZ
> Upgrades plugin's behavior on this pattern, and the v1-via-legacy
> migration path.
>
> Pairs with [`v3-rollout-plan.md`](./v3-rollout-plan.md) (the broader
> rollout decision) and [`access-control-design.md`](./access-control-design.md)
> (why the Controller goes the other direction — ACDAR instead of dropped).

---

## TL;DR

- v3 IDRP **drops `AccessControlUpgradeable` from the inheritance list**.
- The ERC-7201 storage namespace `openzeppelin.storage.AccessControl` is
  **preserved via a `struct AccessControlStorageDeprecated`** with the
  proper `@custom:storage-location` annotation.
- OZ Upgrades plugin **accepts** the v2 → v3 upgrade — verified via
  `hre.upgrades.validateUpgrade` on a sandbox before this was committed.
- The pattern is the same one already in use on the Controller for the
  removed `OwnableUpgradeable` parent (`OwnableStorageDeprecated`).
- The IDRP v3 contract has **zero `onlyRole` modifiers, zero
  `grantRole`/`revokeRole`/`hasRole` in its ABI, and no `initializeV2`**.
  The v1 → v2 migration (still needed for two testnets) lives in
  `contracts/legacy/IDRPv2.sol`.

---

## 1. The pattern

```solidity
contract IDRP is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    // AccessControlUpgradeable removed — namespace preserved below.
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    /// @dev Preserved storage namespace of the removed AccessControlUpgradeable
    ///      parent. OZ Upgrades requires the namespace to remain declared so
    ///      v2→v3 layout comparison passes; the namespace still holds legacy
    ///      role-membership data (DEFAULT_ADMIN_ROLE granted to the Safe at v1
    ///      deploy time) but is no longer read by any path in v3.
    ///
    ///      DO NOT REMOVE this struct. If a future version ever re-inherits
    ///      AccessControlUpgradeable, the legacy entries in this namespace will
    ///      silently regain effect — audit the holder set first via event replay
    ///      (see scripts/list-upgrader-holders.ts for the existing pattern).
    /// @custom:storage-location erc7201:openzeppelin.storage.AccessControl
    struct AccessControlStorageDeprecated {
        mapping(bytes32 role => RoleDataDeprecated) _roles;
    }
    struct RoleDataDeprecated {
        mapping(address => bool) hasRole;
        bytes32 adminRole;
    }
    ...
}
```

Three things to notice:

1. The struct's annotation **must exactly match** the namespace string used
   by OZ's `AccessControlUpgradeable`:
   `erc7201:openzeppelin.storage.AccessControl`. This is the same string OZ
   uses internally (verified in
   `node_modules/@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol:59`).
2. The `RoleDataDeprecated` struct shape **must exactly match** OZ's
   `RoleData` (also defined in that file). Same field types, same order.
3. The struct names themselves (`AccessControlStorageDeprecated`,
   `RoleDataDeprecated`) are local to our contract — OZ doesn't care. The
   `@custom:storage-location` annotation is what binds the namespace.

---

## 2. Why this is safe

### What the OZ Upgrades plugin actually checks

When you call `upgradeProxy` (or `validateUpgrade`), the plugin:

1. Reads the storage layout of the OLD impl (the one currently on the
   proxy).
2. Reads the storage layout of the NEW impl.
3. For ERC-7201 namespaced storage: compares each namespace by its ID
   string. If a namespace exists in both old and new, they must have the
   same layout. If a namespace exists in only the new contract, it's
   ignored as "newly added" (and must come last). If a namespace exists
   only in the old contract, the plugin warns — that's a storage loss
   risk.
4. For sequential storage: standard "you can only append" rules.

By declaring `AccessControlStorageDeprecated` with the same namespace ID
as the old `AccessControlStorage`, we satisfy step 3 — the namespace
exists in both old and new with the same layout.

### Empirical verification

Before committing this pattern, we wrote a sandbox impl that drops
`AccessControlUpgradeable` from inheritance, declares the deprecated
struct, and called `hre.upgrades.validateUpgrade(v2Proxy, sandboxImpl)`.
The plugin accepted the upgrade. (Sandbox files were deleted after the
test; the verification was point-in-time.)

The production V3-1 / V3-3 tests in
`test/security-audit/v3-migration/` exercise the actual v2→v3 and
v1→v2→v3 upgrade paths against the v3 IDRP. All passing.

---

## 3. The dead-namespace warning

The `AccessControlStorageDeprecated` namespace still contains real data on
production proxies. Specifically:

- Every production IDRP proxy was deployed via `initialize(superAdmin)`,
  which called `_grantRole(DEFAULT_ADMIN_ROLE, superAdmin)`. That grant
  wrote to the AccessControl namespace.
- Several chains had additional role grants (e.g. `UPGRADER_ROLE`) before
  the v2 migration revoked them.
- The v2 `initializeV2` migration revoked `UPGRADER_ROLE` from listed
  legacy holders, but did NOT touch `DEFAULT_ADMIN_ROLE`. So the Safe
  address is still in the legacy namespace as a `DEFAULT_ADMIN_ROLE`
  holder.

In v3, **nothing reads this data**. No method in the contract has an
`onlyRole` modifier. The bytecode doesn't include `grantRole`/`hasRole`/
etc. So the data is functionally inert.

But it's not gone. If a future v4 contract ever re-inherits
`AccessControlUpgradeable`, the legacy entries will silently regain
effect:

```solidity
// HYPOTHETICAL FUTURE BUG:
contract IDRPv4 is
    ...,
    AccessControlUpgradeable,   // re-inherited!
    ...
{
    function reset() external onlyRole(DEFAULT_ADMIN_ROLE) { ... }
    // ^^^ Whoever held DEFAULT_ADMIN_ROLE at v1 deploy time (the original
    //     Safe) can call this. The contract didn't grant the role in v4;
    //     it inherited it from dead storage.
}
```

This is the **same risk we already have** with `OwnableStorageDeprecated`
on the Controller (the `_owner` slot still holds the original Safe
address, but nothing reads it). It's documented there too. The mitigation
is the same in both cases:

- The `DO NOT REMOVE` comment on the deprecated struct.
- A clear rule for any future v4 author: if you re-inherit a parent that
  uses a namespaced storage slot we previously deprecated, **enumerate
  the existing holders first** (via event replay) and explicitly revoke
  them in an initializer before the contract can be used in production.

---

## 4. Why this satisfies the auditor ask

The May 2026 audit asked: *"don't gate operational and config methods on
roles"*. The original interpretation was "use `onlyAdmin`/`onlyController`
instead of `onlyRole(X)` everywhere, but `AccessControlUpgradeable` can
still be inherited as long as no method calls it." That's what we had in
Path B.

Path A goes further:

- The role machinery is gone from the bytecode entirely.
- `grantRole`/`revokeRole`/`hasRole`/`getRoleAdmin`/etc. are not in the
  ABI. A user inspecting Etherscan sees a smaller, simpler contract.
- The auditor's narrative becomes "the contract has no role-based access
  control at all" — strictly stronger than "the contract has role-based
  access control but doesn't use it."
- The `AccessControlStorageDeprecated` struct in storage is auditable as
  "a dead-storage reservation, no read paths" — a documented, intentional
  pattern with precedent (the existing `OwnableStorageDeprecated`).

---

## 5. The v1 → v2 migration path under Path A

Two testnets still need v1 → v2 migration (Kaia Kairos IDRP and Base
Sepolia Controller — see [`v3-rollout-plan.md`](./v3-rollout-plan.md#2-live-state-of-all-our-chains-verified-2026-06-02)).

Under Path A, the v3 IDRP cannot do this migration itself — it has no
`initializeV2` function and no `DEFAULT_ADMIN_ROLE` gate. So we deploy
the legacy v2 contract:

```
contracts/legacy/IDRPv2.sol          # byte-for-byte copy of verified mainnet v2 source
contracts/legacy/IDRPControllerv2.sol
```

Same files compile. Same storage layout. The `scripts/v1-to-v2/` folder
deploys these to the affected testnets:

1. `scripts/v1-to-v2/prepare-upgrade.ts` → deploys `IDRPv2` impl
2. `scripts/v1-to-v2/upgrade.ts` → `upgradeToAndCall(newImpl, initializeV2(safe, legacyHolders))`
3. Now the testnet has `upgrader` populated and looks like every mainnet.
4. Continue with the normal `scripts/upgrade.ts` for v2 → v3.

After the affected testnets reach v2, the legacy contracts in
`contracts/legacy/` are dead deploy artifacts — they're not used in
production code paths, but they're kept in source for two reasons:

- Audit/forensic record (the contract is what's actually deployed on those
  testnets between the v1→v2 step and the v2→v3 step).
- Future replay: if a new chain ever launches and ships v1 first
  (unlikely but possible), the same v1→v2 path works.

---

## 6. Storage namespace by the numbers

For reference, the namespace ID hashes (computed via OZ's ERC-7201 formula):

| Namespace | ID hash slot |
|---|---|
| `openzeppelin.storage.AccessControl` | `0x02dd7bc7dec4dceedda775e58dd541e08a116c6c53815c0bd028192f7b626800` |
| `openzeppelin.storage.AccessControlDefaultAdminRules` | `0xeef3dac4538c82c8ace4063ab0acd2d15cdb5883aa1dff7c2673abb3d8698400` |
| `openzeppelin.storage.Ownable` | (deprecated on Controller — different slot) |

These are computed as:
```
keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.X")) - 1)) & ~bytes32(uint256(0xff))
```

The `AccessControlStorageDeprecated` struct in v3 IDRP resolves to the same
slot as the live `AccessControlStorage` does on v2 IDRP — that's what
makes the storage layout compatible.

---

## 7. Related docs

- [`v3-rollout-plan.md`](./v3-rollout-plan.md) — the full Path A vs Path B
  decision and rollout phasing
- [`access-control-design.md`](./access-control-design.md) — why the
  Controller uses ACDAR instead of dropping AccessControl
- [`no-defaultadmin-leftbehind.md`](./no-defaultadmin-leftbehind.md) — the
  Controller's revoke-then-init pattern (parallel safety concern)
- [`acdar-migration-and-tron-multisig-gotchas.md`](./acdar-migration-and-tron-multisig-gotchas.md)
  — the two trapdoors we deliberately avoided
- [`deployed-state-reality.md`](./deployed-state-reality.md) — per-chain
  state matrix
- [`../upgrade/UPGRADE.md`](../upgrade/UPGRADE.md) — operational
  playbook (predates this; needs an update for v3 + scripts/v1-to-v2/)

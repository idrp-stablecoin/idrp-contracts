# Can the contract end up with ZERO `DEFAULT_ADMIN_ROLE` holders? Does it brick?

> Direct answer to your safety question: *"if we revoke the legacy holders
> during `initializeV3` and ACDAR's invariant means only one holder exists at
> a time, what happens if we accidentally end up with none? Does the contract
> become permanently unusable?"*
>
> Spoiler: **the contract does NOT brick**. The four signer roles
> (OFFICER/MANAGER/DIRECTOR/COMMISSIONER) keep working, `executeOperation`
> keeps working, the `upgrader` keeps working. Only ADMIN-gated config
> (rotate upgrader, withdraw stuck tokens, manage signer roles) becomes
> unreachable — and `upgrader` can always rescue that via a new impl + upgrade.
> But there ARE failure modes worth ruling out by construction; this doc spells
> out which ones can happen and how the migration prevents them.

---

## TL;DR

| Scenario | Can it happen? | Effect | Recovery |
|---|---|---|---|
| `initializeV3` tries to revoke last `DEFAULT_ADMIN_ROLE` holder | Cannot happen with the fix below (we revoke legacy holders **before** granting the new one). | — | — |
| Admin runs `renounceRole(DEFAULT_ADMIN_ROLE, self)` via ACDAR | Requires two-step delayed flow (`beginDefaultAdminTransfer(address(0))` + wait + `renounceRole`). Not accidental. | All admin-gated functions become unreachable. Signer roles & `executeOperation` still work. `upgrader` still works. | Deploy a new impl with a `recoverAdmin` function and upgrade to it. |
| Admin renounces, but a future upgrade *needs* admin to migrate | Possible in principle (e.g. v4 `initializeV4(onlyAdmin)`). | Migration impossible without first re-introducing admin via upgrade. | Always include an `upgrader`-gated emergency initializer in any future impl. |
| Single-step revoke of last admin via inherited `_revokeRole` | Impossible — ACDAR's `_revokeRole` override doesn't gate it, but the only public path is `revokeRole`, which ACDAR's override **always reverts for `DEFAULT_ADMIN_ROLE`**. Internal calls aren't reachable from any public method. | — | — |

---

## 1. The OZ source, byte-by-byte

This is what makes the safety story precise. Looking at
`AccessControlDefaultAdminRulesUpgradeable.sol`:

```solidity
// Public path: ALWAYS reverts for DEFAULT_ADMIN_ROLE
function revokeRole(bytes32 role, address account) public virtual override(...) {
    if (role == DEFAULT_ADMIN_ROLE) {
        revert AccessControlEnforcedDefaultAdminRules();
    }
    super.revokeRole(role, account);
}

// Public path: ALWAYS reverts for DEFAULT_ADMIN_ROLE  (same protection)
function grantRole(bytes32 role, address account) public virtual override(...) {
    if (role == DEFAULT_ADMIN_ROLE) {
        revert AccessControlEnforcedDefaultAdminRules();
    }
    super.grantRole(role, account);
}

// Public path: only allows renounce of DEFAULT_ADMIN_ROLE via the delayed flow
function renounceRole(bytes32 role, address account) public virtual override(...) {
    if (role == DEFAULT_ADMIN_ROLE && account == defaultAdmin()) {
        (address newDefaultAdmin, uint48 schedule) = pendingDefaultAdmin();
        if (newDefaultAdmin != address(0) || !_isScheduleSet(schedule) || !_hasSchedulePassed(schedule)) {
            revert AccessControlEnforcedDefaultAdminDelay(schedule);
        }
        delete $._pendingDefaultAdminSchedule;
    }
    super.renounceRole(role, account);
}

// Internal _grantRole: blocks granting if an admin already exists
function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
    if (role == DEFAULT_ADMIN_ROLE) {
        if (defaultAdmin() != address(0)) {
            revert AccessControlEnforcedDefaultAdminRules();
        }
        $._currentDefaultAdmin = account;
    }
    return super._grantRole(role, account);
}

// Internal _revokeRole: clears ACDAR's tracking slot if the current admin is revoked
function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
    if (role == DEFAULT_ADMIN_ROLE && account == defaultAdmin()) {
        delete $._currentDefaultAdmin;
    }
    return super._revokeRole(role, account);
}
```

Three facts you can derive from this:

1. **Once ACDAR is initialized, no public path can revoke `DEFAULT_ADMIN_ROLE`
   except the delayed renounce flow.** Even the current admin can't
   single-tx revoke themselves.
2. **No public path can re-grant `DEFAULT_ADMIN_ROLE` once it's been
   renounced.** The internal `_grantRole` is only reachable from
   `__AccessControlDefaultAdminRules_init` (`onlyInitializing`) and from
   `_acceptDefaultAdminTransfer` (requires `pendingDefaultAdmin` set, which
   itself requires the current admin to call `beginDefaultAdminTransfer`).
   After renounce there's no current admin to call begin.
3. **`renounceRole` is intentionally hard to do by accident.** Two steps,
   delayed, with explicit `address(0)` sentinel. There's no way to
   accidentally trigger it via normal operation.

## 2. What "no DEFAULT_ADMIN_ROLE" actually means functionally

If we accidentally renounce the only admin holder, what stops working?

### Still works ✅

- `executeOperation(...)` — signer-role gated. Quorum signers
  (OFFICER/MANAGER/DIRECTOR/COMMISSIONER) keep functioning.
- `mint`, `burn`, `freeze`, `unfreeze`, `pause`, `unpause` — these
  flow through the `controller`/`upgrader` (IDRP) or `executeOperation`
  (Controller).
- `scheduleUpgrade`, `cancelUpgrade`, `_authorizeUpgrade` — gated by
  `onlyUpgrader`, unaffected.
- All view functions — `hasRole`, `getQuorumRule`, `getOperationHash`, etc.
- Token transfers, sanctions checks, ERC-2612 `permit`.

### Stops working ❌ (and only an upgrade can fix)

On the Controller (uses ACDAR):

- `grantRole(SIGNER_ROLE, x)` / `revokeRole(SIGNER_ROLE, x)` — our overrides
  gate them on `onlyRole(DEFAULT_ADMIN_ROLE)`. **Signer role management is
  frozen.** Existing signers keep working; we can't add/remove them.
- `setQuorumRules`, `scheduleQuorumRules`, `applyQuorumRules`,
  `cancelQuorumRules` — `onlyAdmin` gated. **Quorum rules become frozen at
  their current value.**
- `setUpgrader`, `setAdmin` — `onlyAdmin` gated. **Can't rotate upgrader
  through the contract.** (We can still upgrade to a new impl that sets it,
  via the surviving `upgrader`.)
- `withdrawToken` — stuck tokens stay stuck until a new impl provides
  another path.

On IDRP (custom slots, not ACDAR):

- `setMaxSupply`, `setDepositoryWallet`, `setSanctionsList`,
  `setController`, `setAdmin`, `setUpgrader`, `withdrawToken` — all
  `onlyAdmin`. Frozen.

### Is the contract "bricked"?

**No.** The system keeps doing its job (mint/burn/transfer/quorum
operations). It just can't reconfigure itself. And because `upgrader`
authority survives independently, we can ALWAYS deploy a new impl and
schedule an upgrade. The escape hatch is durable.

## 3. The migration-side guarantee — how the v3 init avoids ending up here

The dual-holder problem (from
[`acdar-migration-and-tron-multisig-gotchas.md`](./acdar-migration-and-tron-multisig-gotchas.md))
required revoking legacy `DEFAULT_ADMIN_ROLE` holders. Done naively, the
sequence

```solidity
// WRONG ORDER — risks "no admin left" if _legacyHolders is the full set
__AccessControlDefaultAdminRules_init(delay, _admin);   // (1) grants new admin
for (uint i = 0; i < _legacyHolders.length; i++) {
    _revokeRole(DEFAULT_ADMIN_ROLE, _legacyHolders[i]); // (2) tries to revoke old
}
```

has a subtle bug: step (1) calls ACDAR's `_grantRole`, which checks
`defaultAdmin() != address(0)`. After (1), `_currentDefaultAdmin = _admin`.
If `_admin` happens to be one of the legacy holders (it usually IS — that's
the whole point of the migration: "keep the same Safe as admin"), step (2)
running `_revokeRole(DEFAULT_ADMIN_ROLE, _admin)` will set
`_currentDefaultAdmin = address(0)` per ACDAR's `_revokeRole` override.
**Result: no admin. Contract goes into the "frozen config" state described above
on the very first tx after migration.**

### The correct order (used in the v3 plan)

```solidity
function initializeV3(
    uint48 _adminDelay,
    address _admin,
    address _upgrader,
    address[] calldata _legacyDefaultAdminHolders
)
    external
    reinitializer(3)
    onlyUpgrader        // (gated by surviving v2 upgrader — see initializeV3-gating doc)
{
    // STEP 1 — Revoke ALL legacy DEFAULT_ADMIN_ROLE holders FIRST.
    //   At this point ACDAR is not initialized yet. defaultAdmin() reads ACDAR's
    //   slot (zero), so ACDAR's _revokeRole override doesn't trigger its
    //   "clear _currentDefaultAdmin" branch. Inherited AccessControl's
    //   _revokeRole runs and clears each legacy holder cleanly.
    for (uint256 i = 0; i < _legacyDefaultAdminHolders.length; i++) {
        _revokeRole(DEFAULT_ADMIN_ROLE, _legacyDefaultAdminHolders[i]);
    }

    // STEP 2 — Now initialize ACDAR with the intended new admin.
    //   __AccessControlDefaultAdminRules_init calls _grantRole(DEFAULT_ADMIN_ROLE, _admin).
    //   The "no existing admin" check passes (ACDAR slot is zero).
    //   Writes _currentDefaultAdmin = _admin and grants role in legacy storage too.
    __AccessControlDefaultAdminRules_init(_adminDelay, _admin);

    // STEP 3 — Wire upgrader rotation if needed.
    if (_upgrader != upgrader) {
        address old = upgrader;
        upgrader = _upgrader;
        emit UpgraderUpdated(old, _upgrader);
    }
}
```

Why this order is safe even when `_admin` is one of the legacy holders:

- Step 1 revokes legacy holders including `_admin`. After step 1,
  `_admin` is NOT a `DEFAULT_ADMIN_ROLE` holder in legacy storage. ACDAR's
  tracking slot is still zero.
- Step 2's `__init` calls `_grantRole(DEFAULT_ADMIN_ROLE, _admin)`. The
  "no existing admin" check sees ACDAR slot is zero → passes.
  `_currentDefaultAdmin = _admin`, AND `super._grantRole` re-adds `_admin`
  to legacy storage. Net result: `_admin` holds the role in both places,
  every other legacy holder is revoked.
- Final state: exactly one `DEFAULT_ADMIN_ROLE` holder (`_admin`). ACDAR
  invariant intact. No accidental brick.

### Test that pins this exact ordering

A dedicated test goes into `test/security-audit/V3-DualHolder.ts`:

1. Deploy v2 mock proxy with `[wallet1, wallet2]` both holding
   `DEFAULT_ADMIN_ROLE`.
2. Upgrade to v3 impl, call `initializeV3(delay, wallet1, upgrader, [wallet1, wallet2])`.
3. Assert `hasRole(DEFAULT_ADMIN_ROLE, wallet1) == true` ← survived because
   step 2 re-grants.
4. Assert `hasRole(DEFAULT_ADMIN_ROLE, wallet2) == false` ← revoked in step 1.
5. Assert `defaultAdmin() == wallet1`.
6. Assert subsequent `grantRole(OFFICER_ROLE, x)` from wallet1 succeeds.

Plus the negative case (the "wrong order" failure mode, demonstrated on a
**different** impl that does the steps backwards) so it's visibly captured
in the test suite as something we deliberately avoided.

## 4. Why we still want a recovery path even though it's hard to brick

Even with the correct ordering, there are scenarios where ending up with no
admin is possible:

- **A future audit recommends renouncing admin entirely**, deferring all
  ongoing role management to a multisig that's solely the `upgrader`. Could
  be tempting if it simplifies the threat model.
- **An ops mistake**: the only admin Safe loses quorum (one or two key
  holders leave the company, threshold no longer reachable, the Safe is
  effectively dead).
- **Future migration code bug**: a v4 init that miscalculates the legacy
  holder list and accidentally revokes the new admin too.

In any of these cases, `upgrader` survives. The recovery is:

1. Deploy a new impl (`IDRPControllerEmergencyRecovery.sol`) that contains
   an `emergencyGrantAdmin(address newAdmin) external onlyUpgrader`
   function. This function bypasses ACDAR's gates by calling the
   inherited `AccessControlUpgradeable._grantRole` directly. Internally
   sets ACDAR's `_currentDefaultAdmin` slot too.
2. Schedule upgrade (48h timelock).
3. Execute upgrade.
4. Call `emergencyGrantAdmin(Safe)` from the upgrader.
5. Optionally upgrade back to the normal v3 impl now that admin is restored.

This recovery uses the same authority (`upgrader`) that we always rely on
for code changes. It does not introduce a new trust assumption beyond what
the system already has.

**Action item**: add a brief `RECOVERY.md` to `docs/` covering this flow
so the runbook exists before we need it. (Stub OK; can be filled in if/when
we actually need it.)

## 5. What about the IDRP side (no ACDAR)?

IDRP doesn't use ACDAR — it uses three plain single-address slots
(`admin`, `controller`, `upgrader`). The "no admin" question is even
simpler there:

- `admin` is just a slot. There's no two-step delayed transfer, no
  invariant enforcement. `setAdmin(address(0))` is explicitly rejected by
  `require(_admin != address(0), "Invalid admin")`.
- The only way `admin` could become zero is if a future upgrade introduces
  a bug. Defense: the existing `setAdmin` revert + the storage-preservation
  tests catching any accidental layout shift.
- If it did happen: same recovery as above — `upgrader` deploys an impl
  with a `recoverAdmin` function.

So on IDRP the "no admin" scenario is even harder to reach than on the
Controller — there's no ACDAR machinery that could subtly miscount holders.

## 6. Direct answer to your safety questions

> **"is there any revert for revoking the last DEFAULT_ADMIN_ROLE?"**

There's no special "last holder" check. ACDAR enforces "at most one holder
via the tracking slot" but allows the tracking slot to be zeroed out (via
renounce or `_revokeRole` of the current admin). What revokes "the last
admin" via a public path is **only** the delayed two-step renounce. The
`revokeRole` public path always reverts for `DEFAULT_ADMIN_ROLE`,
regardless of how many holders there are.

> **"if so, the contract not longer can be used right?"**

No — the contract keeps doing its primary job (`executeOperation` and all
its child operations on IDRP). What stops is config/management — and that
can be restored via `upgrader` deploying an impl with a recovery function.

> **"or theres any revert for revoke the last DEFAULT_ADMIN_ROLE? or just
> permanently has no default admin role, so must be upgrade, since the
> upgrader now has authorize"**

Exactly that. The architecture you sketched is correct: admin authority
and upgrader authority are **deliberately separate**, so loss of one
doesn't strand the system. `upgrader` is the durable escape hatch.

> **"we should re think about things like this to prevent negative scenario"**

That's what this doc, the ordered `initializeV3`, and the V3-DualHolder
test are for. Concretely the protections in place:

1. The migration body itself is ordered so "no admin" can't happen by
   accident on `initializeV3`.
2. ACDAR's design makes "no admin" unreachable via single-tx mistakes — it
   takes a deliberate two-step delayed renounce.
3. `upgrader` is independent and durable.
4. A stub `RECOVERY.md` documents the upgrade-path rescue so the runbook
   exists ahead of need.

---

## 7. Related

- ACDAR dual-holder migration trap: [`acdar-migration-and-tron-multisig-gotchas.md`](./acdar-migration-and-tron-multisig-gotchas.md)
- Why `initializeV3` is gated by `onlyUpgrader` now: [`initializeV3-gating.md`](./initializeV3-gating.md)
- Verified mainnet source (the reason we know v2 is deployed): [`../../deployment/logs/contracts/README.md`](../../deployment/logs/contracts/README.md)
- Plan: [`notes/features/idrp-contracts/on-progress/no-access-control/plan.md`](../../../notes/features/idrp-contracts/on-progress/no-access-control/plan.md)

# Two Gotchas to Be Aware Of — ACDAR Migration & TRON Multisig

> Two distinct questions you raised that turned out to have non-obvious answers.
> Capturing them in one doc because both fall under "what could go wrong with
> the authority model" and both have *load-bearing* answers — getting either
> wrong silently breaks the security story.
>
> Date: 2026-06-02. Branch: `access-controll`.

---

## Question 1 — When two wallets already hold `DEFAULT_ADMIN_ROLE`, what happens after migrating to ACDAR?

### TL;DR (read this first)

**If we just call `__AccessControlDefaultAdminRules_init(delay, walletX)` during
`initializeV3` without revoking the legacy holders first, the contract ends up
with THREE effective `DEFAULT_ADMIN_ROLE` holders** — `wallet1`, `wallet2`, AND
`walletX` — while ACDAR's `defaultAdmin()` view returns only `walletX`. ACDAR's
single-holder invariant is silently violated, and the legacy holders cannot be
removed through ACDAR's own API (its `revokeRole` rejects `DEFAULT_ADMIN_ROLE`).

**Fix:** revoke the legacy holders **explicitly inside `initializeV3`, BEFORE
calling `__AccessControlDefaultAdminRules_init`**, using the inherited
`AccessControlUpgradeable._revokeRole` (which doesn't have ACDAR's reverts
because ACDAR isn't initialized yet at that point in the same tx). Same shape as
the existing `initializeV2` that already revokes legacy `UPGRADER_ROLE` holders.

### The OZ source, line by line

Looking at `AccessControlDefaultAdminRulesUpgradeable.sol` (OZ v5):

```solidity
function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
    AccessControlDefaultAdminRulesStorage storage $ = _getAccessControlDefaultAdminRulesStorage();
    if (role == DEFAULT_ADMIN_ROLE) {
        if (defaultAdmin() != address(0)) {                   // <-- check (1)
            revert AccessControlEnforcedDefaultAdminRules();
        }
        $._currentDefaultAdmin = account;                      // <-- write (2)
    }
    return super._grantRole(role, account);                    // <-- write (3)
}

function defaultAdmin() public view virtual returns (address) {
    AccessControlDefaultAdminRulesStorage storage $ = _getAccessControlDefaultAdminRulesStorage();
    return $._currentDefaultAdmin;                             // <-- ONLY reads ACDAR namespace
}
```

`defaultAdmin()` reads only the **new ACDAR ERC-7201 namespace**
(`openzeppelin.storage.AccessControlDefaultAdminRules`). It does NOT look at the
inherited `AccessControlUpgradeable` storage (`openzeppelin.storage.AccessControl`)
where the legacy `_roles[DEFAULT_ADMIN_ROLE].hasRole[address]` mapping lives.

So at the moment we run `__AccessControlDefaultAdminRules_init(delay, walletX)`:

| Slot                                                                | Value before init       | Value after init     |
|---------------------------------------------------------------------|-------------------------|----------------------|
| Legacy `_roles[DEFAULT_ADMIN_ROLE].hasRole[wallet1]`                  | `true`                  | **still `true`**     |
| Legacy `_roles[DEFAULT_ADMIN_ROLE].hasRole[wallet2]`                  | `true`                  | **still `true`**     |
| Legacy `_roles[DEFAULT_ADMIN_ROLE].hasRole[walletX]`                  | `false`                 | `true` (via super._grantRole) |
| ACDAR `$._currentDefaultAdmin`                                      | `address(0)`            | `walletX`            |

After the migration:

- `hasRole(DEFAULT_ADMIN_ROLE, wallet1)` → **`true`** (from legacy storage).
- `hasRole(DEFAULT_ADMIN_ROLE, wallet2)` → **`true`** (from legacy storage).
- `hasRole(DEFAULT_ADMIN_ROLE, walletX)` → **`true`**.
- `defaultAdmin()` → `walletX` (reads ACDAR storage only).

Three on-chain holders, single "official" holder per the ACDAR view. **This is
the worst kind of bug**: a public method (`defaultAdmin()`) confidently lies
about the truth, and any logic that gates on `onlyRole(DEFAULT_ADMIN_ROLE)`
still accepts the legacy holders.

### The trap with revoking legacy holders POST-init

You might think "OK, just call `revokeRole(DEFAULT_ADMIN_ROLE, wallet1)` after
init to clean up." That fails — ACDAR's `revokeRole` is:

```solidity
function revokeRole(bytes32 role, address account) public virtual override(AccessControlUpgradeable, IAccessControl) {
    if (role == DEFAULT_ADMIN_ROLE) {
        revert AccessControlEnforcedDefaultAdminRules();   // <-- always reverts for DEFAULT_ADMIN_ROLE
    }
    super.revokeRole(role, account);
}
```

ACDAR explicitly removes the ability to revoke `DEFAULT_ADMIN_ROLE` via the
standard API. The only way to remove a `DEFAULT_ADMIN_ROLE` holder under ACDAR
is the two-step transfer:
`beginDefaultAdminTransfer(newAdmin)` → wait delay →
`acceptDefaultAdminTransfer()` (which internally `_revokeRole`s the current admin
then `_grantRole`s the new one).

That two-step flow:
- Only works for **the address ACDAR thinks is the current admin** (i.e.
  `defaultAdmin()`, which is `walletX`). It cannot be used to remove
  `wallet1` or `wallet2` because ACDAR doesn't know about them.
- Even after running it, ACDAR's `_revokeRole` only revokes the current
  `defaultAdmin()` from BOTH ACDAR's namespace and the legacy namespace —
  the legacy holders that ACDAR doesn't track are never touched.

**Net: under ACDAR, there is no public path to revoke `wallet1`/`wallet2`
after init.** The legacy holders persist forever unless we clean them up
during initialization, while we still have access to `AccessControlUpgradeable`'s
unguarded `_revokeRole`.

### The fix — pattern that mirrors `initializeV2`

The existing `initializeV2` already solves the same shape of problem for
`UPGRADER_ROLE`: pass an array of legacy holders (gathered off-chain via event
replay) and revoke them as part of the migration. We do the same for
`DEFAULT_ADMIN_ROLE`:

```solidity
function initializeV3(
    uint48 _adminDelay,
    address _admin,
    address _upgrader,
    address[] calldata _legacyDefaultAdminHolders   // ← critical new param
)
    external
    reinitializer(3)
    onlyRole(DEFAULT_ADMIN_ROLE)                     // (or onlyUpgrader — separate decision)
{
    // 1) Revoke EVERY current DEFAULT_ADMIN_ROLE holder via inherited
    //    AccessControlUpgradeable._revokeRole — this still works at this
    //    point because __AccessControlDefaultAdminRules_init hasn't been
    //    called yet, so ACDAR's override isn't on the dispatch path for
    //    _grantRole/_revokeRole during this exact call.  See note below.
    for (uint256 i = 0; i < _legacyDefaultAdminHolders.length; i++) {
        _revokeRole(DEFAULT_ADMIN_ROLE, _legacyDefaultAdminHolders[i]);
    }

    // 2) NOW initialize ACDAR with the new (intended single) admin.
    //    __AccessControlDefaultAdminRules_init reverts if defaultAdmin()
    //    is non-zero, which it isn't (ACDAR namespace is virgin).
    __AccessControlDefaultAdminRules_init(_adminDelay, _admin);

    // 3) Wire the v3 upgrader/controller as before.
    upgrader = _upgrader;
    emit UpgraderUpdated(address(0), _upgrader);
    // ... etc
}
```

⚠ **Important Solidity dispatch nuance:** because ACDAR overrides `_grantRole`
and `_revokeRole`, calling `_revokeRole` from `initializeV3` **does** go through
ACDAR's override. That's still safe because ACDAR's `_revokeRole` only has special
behavior when `account == defaultAdmin()`, and at this point in the tx
`defaultAdmin()` returns `address(0)` (ACDAR's slot is still zero). So
`_revokeRole(DEFAULT_ADMIN_ROLE, wallet1)` just delegates straight to
`super._revokeRole`, which clears the legacy storage. Confirmed by inspecting OZ
v5.0.0 source. **Test this explicitly in `V3-DualHolder.t.sol`** (see test list
at end).

### How to enumerate the legacy holders

`AccessControlUpgradeable` is NOT the enumerable variant, so there's no on-chain
way to list current `DEFAULT_ADMIN_ROLE` holders. Same problem as `UPGRADER_ROLE`
in `initializeV2`. Same solution: write
`scripts/list-default-admin-holders.ts` that replays `RoleGranted` /
`RoleRevoked` events from the proxy's full history and outputs a JSON file
per chain (mirrors the existing `scripts/list-upgrader-holders.ts`).

That JSON is then passed to `upgradeToAndCall(v3Impl, initializeV3(..., holders))`.

### Action items

- [ ] Update `IDRPController.initializeV3` signature to take
      `address[] calldata _legacyDefaultAdminHolders` and revoke them all
      before `__AccessControlDefaultAdminRules_init`.
- [ ] Add `scripts/list-default-admin-holders.ts` (event replay).
- [ ] Add `V3-DualHolder.ts` security-audit test that:
      - Deploys a v1 mock with TWO `DEFAULT_ADMIN_ROLE` holders.
      - Runs the v3 migration.
      - Asserts `hasRole(DEFAULT_ADMIN_ROLE, wallet1) == false`.
      - Asserts `hasRole(DEFAULT_ADMIN_ROLE, wallet2) == false`.
      - Asserts `defaultAdmin() == walletX`.
      - Asserts `hasRole(DEFAULT_ADMIN_ROLE, walletX) == true`.

### Bonus: this is also why initialize order matters in `initialize` (fresh deploy)

`__AccessControlDefaultAdminRules_init` enforces "no existing admin." If we
accidentally call `_grantRole(DEFAULT_ADMIN_ROLE, walletA)` first (e.g. via an
old `__AccessControl_init` pattern) and then call
`__AccessControlDefaultAdminRules_init(delay, walletB)`, the latter reverts
(`defaultAdmin() != address(0)` … wait, but `defaultAdmin()` reads ACDAR's slot
which is still zero — so it would NOT revert, and we'd end up with the same
two-holder mess). Mitigation: never `_grantRole(DEFAULT_ADMIN_ROLE, ...)`
manually in `initialize`/`initializeV3`. Always go through
`__AccessControlDefaultAdminRules_init`.

---

## Question 2 — TRON multisig: can the account itself be in the signer list? What if a key is compromised?

> Builds on [`notes/tron/native-multisig.md`](../../../notes/tron/native-multisig.md)
> (which covers the structure and threshold mechanics — read that first if
> unfamiliar).

### TL;DR

- **Yes, the account itself CAN appear in its own `keys` list** — and in fact
  for many setups it's the default. The "owner" permission's `keys` array
  defaults to `[{ address: <account>, weight: 1 }]` with threshold 1 when the
  account is created. That's just a normal single-sig account. Once you set up
  a real multisig you typically REMOVE the account's own key from the list and
  replace it with N external signing keys — but the protocol doesn't require
  you to.
- **Including the account in its own key list is allowed but pointless.** The
  account address is the *identity* being signed *for*. Self-inclusion doesn't
  add a signing party — whichever key actually signed (from the keys list)
  authorized the action. It only matters if you set per-key `weight` differently.
- **If a multisig key is compromised:** the account is NOT instantly broken
  *unless* the compromised key has weight ≥ threshold on its own. The whole
  point of multisig is that one compromised key can't act alone. To remediate,
  the other key-holders co-sign a new `AccountPermissionUpdateContract` to
  rotate the compromised key out. If the compromised key was on the **owner**
  permission and had enough weight, the attacker can also rewrite permissions
  — at that point recovery requires racing the attacker or using an external
  recovery key holder.

### Q2a — Can the account itself be in the signers?

TRON's account model:

```
Account (address T...XYZ)
├── owner permission   (type 0, threshold + up to 5 keys)
├── witness permission (type 1, SRs only)
└── active permissions (type 2+, up to 8, each with threshold + up to 5 keys)
```

A "key" in the `keys` array is just an address with a `weight`. The protocol
accepts ANY address there — including the account's own address. So this is
valid:

```jsonc
// permission for account T...XYZ, including T...XYZ itself
{
  "threshold": 2,
  "keys": [
    { "address": "T...XYZ",     "weight": 1 },   // ← the account itself
    { "address": "TKeyA...",    "weight": 1 },
    { "address": "TKeyB...",    "weight": 1 }
  ]
}
```

**Does it do anything?** Only if a transaction from this account is signed
with the private key that controls `T...XYZ`. But… the "account's own key" only
exists as a meaningful concept *before* you've changed the permissions. If you
created the account from privkey `K`, then `T...XYZ` is derived from `K`, and
including `T...XYZ` in the keys list effectively says "the original creation
key is still a valid signer." Most multisig setups deliberately *remove* the
creation key from the keys list, so the original single signer is no longer
authorized — that's the whole point of moving to multisig.

**Practical guidance:**
- For a fresh multisig setup, the typical pattern is:
  - Generate N **new** signer keys (held by separate humans/devices/HSMs).
  - List those N addresses in the `keys` array with the desired weights.
  - Do **not** include the account's own pre-multisig key — the migration tx
    itself is signed by the old single key for the last time, and after the
    migration that key is no longer authoritative.
- Self-including the account adds nothing operationally and creates auditor
  confusion ("why is the account in its own signer list?"). Avoid.

### Q2b — What if a multisig key is compromised?

This depends on **(i) which permission level** the compromised key is on, and
**(ii) its weight relative to the threshold**.

#### Case A — Compromised key on an `active` permission, weight < threshold

✅ **Safe.** This is exactly what multisig is designed for. The attacker holds
one key out of N. They cannot reach the threshold alone. The other key-holders
remediate by signing an `AccountPermissionUpdateContract` that removes the
compromised key (or rotates its address). Cost: 100 TRX.

#### Case B — Compromised key on an `active` permission, weight ≥ threshold

⚠️ **Permissioned damage, scoped to that permission's `operations` bitmask.**
The attacker can perform any operation that bitmask allows (e.g. TRX transfers,
TRC-20 transfers) — but **cannot** rewrite permissions (only the *owner*
permission can do `AccountPermissionUpdateContract`). Loss is limited to what
that active permission was scoped to do.

Remediation: holders of the **owner** permission (which is separate) co-sign a
new permissions update to revoke or restrict the compromised active permission.

#### Case C — Compromised key on the `owner` permission, weight < threshold

✅ **Safe** — same as Case A but at owner level. Attacker alone can't change
permissions or do anything else owner-gated. Remaining owner-permission holders
rotate the compromised key out.

#### Case D — Compromised key on the `owner` permission, weight ≥ threshold

🚨 **Catastrophic.** Attacker can rewrite all permissions
(`AccountPermissionUpdateContract`) and seize the account. There is no
protocol-level rescue — TRON does not have a "social recovery" or "guardian"
mechanism, and there is no analogue to upgrading a Safe contract.

Race-condition recovery is the only hope:
- If you detect the compromise *before* the attacker acts AND remaining
  legitimate signers (if any) can reach quorum without the compromised key,
  rush a permissions update tx. This is essentially a frontrunning race against
  the attacker.
- If the compromised key alone has owner-weight ≥ threshold (e.g.
  threshold = 1, single owner key), nothing can save the account.

**Operational implication for IDRP on TRON:**
- The owner permission's threshold should be **strictly greater than the
  weight of any single key**. E.g. 3-of-5 with all weights = 1 means no single
  compromised key reaches threshold = 3. A 1-of-1 owner permission is just an
  EOA with extra ceremony; do not use.
- The `active` permissions used for routine operations (transfers, etc.)
  should be **separate keys** from the owner permission, scoped via the
  `operations` bitmask to only what's needed. That way compromising an
  operational key cannot escalate to permission rewriting.
- Detection and response runbooks should exist for "key X is compromised" —
  who signs the remediation tx, how fast can they co-sign, what the
  fallback is.

### Comparison to EVM Safe behavior

|                                       | EVM Safe                                                                     | TRON multisig                                              |
|---------------------------------------|------------------------------------------------------------------------------|------------------------------------------------------------|
| One owner key compromised, threshold N>1 | Safe untouched. Other owners replace the compromised owner via `swapOwner`. | Account untouched. Other key-holders co-sign permissions update. |
| All owner keys lost                    | Safe is unrecoverable.                                                       | Account is unrecoverable.                                  |
| Recovery / guardian mechanism          | Available via Safe modules / recovery (Sentinel etc).                        | Not native. Must be built off-chain (out-of-band signers).  |
| Permission rewrite authority           | Owners with threshold can call `changeThreshold` / `swapOwner`.              | Only `owner` permission keys can `AccountPermissionUpdate`. |

### Action items for IDRP TRON setup

- [ ] Document the **threshold and weight matrix** for the IDRP TRON account
      in a `deployment/chain-tron.json` (or similar) — including owner
      permission, every active permission, what each is scoped to.
- [ ] Confirm the owner permission threshold is ≥ 2 with no single key having
      weight ≥ threshold.
- [ ] Confirm the operational active permission is a DIFFERENT signer set from
      the owner permission (so an operational-key compromise can't escalate).
- [ ] Write the key-compromise remediation runbook (who signs, where keys are
      stored, what is the SLA for emergency rotation).

---

## How these two interact

They don't, directly — Question 1 is an EVM-only ACDAR migration concern,
Question 2 is a TRON account-permissions concern. But they share the same
underlying lesson:

> **The "single admin" or "secure multisig" guarantee is only as strong as the
> setup tx that creates it.** Get that one tx wrong (legacy holders not
> revoked; owner threshold too low; self-key still in the list) and the
> guarantee silently doesn't hold. Both contracts AND off-chain ops must
> co-verify the post-setup state by reading the chain back.

So for both: write a `post-{migration|setup}-assertions` script that confirms
the on-chain reality matches the intended state. Run it as the LAST step of
any migration/setup, not as a separate "we'll check later" task.

---

## References

- ACDAR source (OZ v5): `node_modules/@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol`
- ACDAR docs: https://docs.openzeppelin.com/contracts/5.x/api/access#AccessControlDefaultAdminRules
- TRON multisig basics: [`notes/tron/native-multisig.md`](../../../notes/tron/native-multisig.md)
- TRON account permissions: https://developers.tron.network/docs/account-permission-management
- Existing event-replay pattern for `UPGRADER_ROLE`: [`scripts/list-upgrader-holders.ts`](../../scripts/list-upgrader-holders.ts)
- Related design docs: [`access-control-design.md`](./access-control-design.md) · [`initializeV3-gating.md`](./initializeV3-gating.md) · [`deployed-state-reality.md`](./deployed-state-reality.md)

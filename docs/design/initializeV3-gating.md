# Why `initializeV3` is gated by `DEFAULT_ADMIN_ROLE`, not `upgrader`

> ## ⚠ STATUS: SUPERSEDED (2026-06-02)
>
> The premise of this doc — "`upgrader()` reverts on production, so we must use
> `DEFAULT_ADMIN_ROLE`" — turned out to be based on a **wrong-selector bug** in
> the on-chain probes. Production proxies DO have the `upgrader` slot populated
> (selector for `upgrader()` is `0xaf269745`, not the `0xf72c0d8b` I used,
> which is actually `UPGRADER_ROLE()`).
>
> **Corrected analysis: [`deployed-state-reality.md`](./deployed-state-reality.md)**
>
> Short version: on all four prod mainnets, `upgrader = 0xb2480DF5…c1779`. So
> `initializeV3` CAN be gated by `onlyUpgrader`. The arguments below about
> "DEFAULT_ADMIN_ROLE is the only key that fits" are wrong for prod — both keys
> fit. The doc is kept for the chronology discussion and the "alternatives"
> section, but the recommendation is reversed: **use `onlyUpgrader` (or a
> DEFAULT_ADMIN_ROLE-OR-upgrader OR-gate to also cover testnets that didn't run
> `initializeV2`).** See `deployed-state-reality.md` §4.1.

---

> Answers the design question: "v2 introduced `upgrader` — `initializeV3` should
> logically be called by the upgrader, right?" This doc walks through the
> chronology and shows why `DEFAULT_ADMIN_ROLE` is the only correct gate for the
> production migration.

---

## TL;DR

- "Use `upgrader`" assumes every proxy has run `initializeV2`. **On production,
  none of them have** (verified by direct RPC probe: `upgrader()` reverts on
  Ethereum, Polygon, BSC, Kaia).
- `initializeV3` therefore can't be gated by `onlyUpgrader` — the slot is
  empty and the function would be unrunnable.
- `DEFAULT_ADMIN_ROLE` is the **only authority that exists on every chain
  today** (it was granted in v1's `initialize`). It is therefore the only
  workable gate for the migration tx.
- Fresh deploys do not go through `initializeV3` at all — they call `initialize`
  (the v1 entry point) which writes v3 state directly. The `DEFAULT_ADMIN_ROLE`
  gate is **migration-only**.

---

## 1. Where the question comes from

The v3 source ships three single-address authorities: `admin`, `controller`
(IDRP only), `upgrader`. A natural reading is "upgrader handles upgrades; the
upgrade *includes* `initializeV3`; therefore upgrader gates it." That logic
holds **on paper**, but it depends on the proxy already having an upgrader set.

That assumption is the bug. Let's walk the actual chronology.

---

## 2. The chronology of authority on production proxies

### v1 (what's actually deployed today)

`initialize(superAdmin)` ran once, long ago. It granted
`DEFAULT_ADMIN_ROLE` to the Safe address and set up the role-based authority
model. The contract had **no `upgrader` slot at all** — upgrade authorization
went through `onlyRole(UPGRADER_ROLE)` (a separate role) or `onlyOwner` on the
Controller. The state of every production proxy still reflects exactly this.

### v2 (designed, never deployed)

This is where `upgrader` was introduced as a single-address slot, alongside the
48h timelock. The migration `initializeV2(_upgrader, _legacyHolders)` was
written to:
- copy authority from the v1 `UPGRADER_ROLE` to the new `upgrader` slot,
- revoke `UPGRADER_ROLE` from every legacy holder so the role can't be silently
  reintroduced.

`initializeV2` was gated by `onlyRole(DEFAULT_ADMIN_ROLE)` — the same authority
that gates `initializeV3` today, and for the same reason: it's the only
authority that exists *before* the migration runs.

But `initializeV2` was **never executed on any production chain**. The
[UPGRADE_HISTORY](../upgrade-history/UPGRADE_HISTORY.md) log shows the last
production upgrade was the Dec-2025 burn-logic fix, which kept the proxies on
v1 (`_initialized == 1`). RPC probes confirm: `upgrader()` reverts on every
production proxy.

### v3 (this refactor)

Now we want to migrate the v1 proxies. The proxy's surviving authority is:

- ✅ `DEFAULT_ADMIN_ROLE` (granted in v1's `initialize`)
- ❌ `upgrader` (slot doesn't exist; calls revert)
- ❌ `owner` (Ownable was never used / was removed before deploy)

There is **only one** authority we can ask to authorize a migration tx: the one
that exists. That's `DEFAULT_ADMIN_ROLE`.

---

## 3. Why "use upgrader" would silently break the migration

If `initializeV3` were gated by `onlyUpgrader`, the call sequence on a
production chain would be:

```
upgradeToAndCall(v3Impl, initializeV3(admin, ctrl, upgrader))
   │
   └─► implementation switches to v3
       └─► initializeV3 body runs
           └─► onlyUpgrader modifier checks `msg.sender == upgrader`
               └─► `upgrader` is address(0) (slot was never written)
                   └─► msg.sender ≠ 0  →  REVERT (NotUpgrader)
                       └─► entire `upgradeToAndCall` reverts
                           └─► proxy stays on v1 forever
```

There is no way out of this without redeploying the proxy (impossible — it
holds real user balances). So `onlyUpgrader` is a non-starter for the migration
entry point, regardless of how aesthetically appealing it is.

---

## 4. Why `DEFAULT_ADMIN_ROLE` is also the *right* choice (not just the only one)

Beyond "it's all that exists", `DEFAULT_ADMIN_ROLE` is the correct gate for
three substantive reasons:

### 4.1 Frontrun safety

`DEFAULT_ADMIN_ROLE` is held by the Safe. An attacker cannot beat the Safe to
the `initializeV3` call without compromising the Safe quorum — same protection
as the existing MINOR-1/MINOR-2 audit fixes (which also gate `initializeV2` by
`DEFAULT_ADMIN_ROLE` for the same reason).

If the Safe is compromised the attacker already controls the whole system —
the migration gate doesn't matter at that point.

### 4.2 Same authority that originally configured the proxy

The address that holds `DEFAULT_ADMIN_ROLE` today is the same address that ran
`initialize(superAdmin)` originally. Letting it run `initializeV3` is the
narrowest possible reuse of pre-existing authority — no new trust assumption
is introduced.

### 4.3 The gate disappears after migration

After `initializeV3` runs:

- The role still exists in storage (we can't *delete* it on the interim impl)
  but **no method in the contract reads it anymore**. Every gated method is
  `onlyAdmin` / `onlyController` / `onlyUpgrader`, and the overridden
  `grantRole`/`revokeRole` bypass the role-admin machinery.
- The IDRP final v3 impl drops `AccessControlUpgradeable` entirely — the role
  is then *gone from the bytecode*, not just dead.
- On the Controller (assuming we adopt ACDAR — see
  [access-control-design.md](./access-control-design.md)), `DEFAULT_ADMIN_ROLE`
  becomes the **strict, two-step, delayed** ACDAR-managed admin — strictly
  *better* than a custom slot, not worse.

So we are using the v1 role once, for the migration only, and then either
deleting it (IDRP) or upgrading it to a stricter form (Controller). It is not
preserved as an open backdoor.

---

## 5. What about fresh deploys?

`initializeV3` is **not** called on fresh deploys. The deploy flow is:

```
hre.upgrades.deployProxy(IDRP_v3, [superAdmin])
   └─► ERC1967Proxy created
       └─► initialize(superAdmin) runs
           ├─► admin = superAdmin           (v3 state)
           ├─► upgrader = superAdmin        (v3 state)
           ├─► controller = address(0)      (wired post-deploy via setController)
           ├─► _grantRole(DEFAULT_ADMIN_ROLE, superAdmin)   (interim only)
           └─► _initialized = 1
```

A fresh deploy reaches v3 state via the v1-style `initialize` entry point and
ends up at `_initialized == 1`. Calling `initializeV3` afterward is **not
required**, and is actively prevented by `reinitializer(3)` if attempted
after a future v4 ever bumps the counter past 3.

The reason `initialize` still grants `DEFAULT_ADMIN_ROLE` on a fresh v3 deploy
is that the **interim IDRP impl still inherits `AccessControlUpgradeable`** —
without granting the role, the modifier `onlyRole(DEFAULT_ADMIN_ROLE)` on
`initializeV3` would have nothing to check against in the (rare) case someone
wanted to call it on a fresh proxy. The final IDRP impl removes both the
inheritance and the grant.

---

## 6. Could we gate `initializeV3` differently?

Three alternatives and why they don't work better:

### Alternative A — Gate by `msg.sender == EXPECTED_ADMIN_ADDRESS` (hardcoded)

- ❌ Different per chain — would require a per-chain build artifact.
- ❌ Loses the ability to rotate the migration runner without redeploying.
- ❌ Auditor-hostile (constant address in code that determines authorization).

### Alternative B — No gate (`reinitializer(3)` is enough)

- `reinitializer(3)` only guarantees "runs at most once", not "the right caller".
  Without a gate, anyone can frontrun the migration and seize all three v3
  authority slots in their own values.
- ❌ Critical security regression. Same trap MINOR-1 / MINOR-2 patched.

### Alternative C — Gate by holder-of-EIP-1967-admin (proxy admin)

- Our proxies are UUPS, not Transparent. There is no proxy admin slot in
  the EIP-1967 sense.
- ❌ Doesn't apply.

### Alternative D — Gate by `_authorizeUpgrade` (rolling the migration into the upgrade itself)

- Tempting but wrong: `_authorizeUpgrade` already runs (correctly) gated by
  `onlyUpgrader` for *future* upgrades. For the v1→v3 migration the proxy is
  *upgrading FROM v1*, where `_authorizeUpgrade` is gated by **the v1
  `onlyRole(UPGRADER_ROLE)` check**, which has its own per-chain holder set
  (see `scripts/list-upgrader-holders.ts`). The upgrade tx will use that
  authority. The *post*-upgrade `initializeV3` body, separately, needs a
  gate that exists *after* the implementation switches — and that's
  `DEFAULT_ADMIN_ROLE`.
- ❌ Conflates upgrade authority and migration authority. Two separate things.

---

## 7. The operational uncertainty this surfaces

There is one open question this analysis raises that needs an answer **before
migration day, not at the contract layer**:

> **Who actually holds `DEFAULT_ADMIN_ROLE` on each production chain today?**

A spot check on Ethereum mainnet showed that the address recorded in
`deployment/chain-1.md` as `admin` does NOT hold `DEFAULT_ADMIN_ROLE`. That
means *some other address* (presumably a Safe set up later, or a rotation we
don't have records of) is the actual holder. We must:

1. Replay `RoleGranted` / `RoleRevoked` events on each prod proxy to enumerate
   the current `DEFAULT_ADMIN_ROLE` holders (analogous to
   `scripts/list-upgrader-holders.ts`, which already does this for
   `UPGRADER_ROLE`).
2. Confirm the resulting set matches the governance-approved Safe address per
   chain.
3. Use that Safe to sign the `upgradeToAndCall(v3Impl, initializeV3(...))` tx.

If the holder on any chain turns out to be unexpected, treat that as an ops
incident first (rotate the role to the correct Safe) and *only then* run the
migration.

---

## 8. Summary

```
┌─────────────────────────────────────────────────────────────────────────┐
│ v1 proxy (production today)                                             │
│   • holds DEFAULT_ADMIN_ROLE (✅ usable)                                 │
│   • no `upgrader` slot       (❌ unusable)                               │
│   • no `owner`               (❌ unusable)                               │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                upgradeToAndCall(v3Impl, initializeV3(...))
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ v3 impl `initializeV3` body                                             │
│   modifier onlyRole(DEFAULT_ADMIN_ROLE)   ← the ONLY gate that fits     │
│   reinitializer(3)                        ← runs at most once           │
│   writes admin, upgrader, (controller for IDRP)                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Post-migration                                                          │
│   • admin/upgrader/(controller) populated                               │
│   • DEFAULT_ADMIN_ROLE still in storage, but unreadable by any method   │
│   • IDRP: final v3 impl removes AccessControlUpgradeable entirely       │
│   • Controller: under ACDAR, DEFAULT_ADMIN_ROLE becomes the strict      │
│     two-step admin (strictly better than custom slot)                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Related

- v1 / v2 / v3 version table: [`upgrade-versions-timeline.md`](./upgrade-versions-timeline.md)
- Whether to use ACDAR on the Controller: [`access-control-design.md`](./access-control-design.md)
- Why we don't validate the admin is a multisig on-chain: [`multisig-validation.md`](./multisig-validation.md)
- Operational migration playbook: [`docs/upgrade/UPGRADE.md`](../upgrade/UPGRADE.md)

# Access Control Design — v3 (no-access-control refactor)

> Status: **proposal under review**. Pairs with the no-access-control plan in
> `notes/features/idrp-contracts/on-progress/no-access-control/plan.md`.
> Date: 2026-06-02. Branch: `access-controll`.

---

## TL;DR

- The audit ask is "remove `AccessControlUpgradeable` from IDRP; keep it on the
  Controller only for the four signer roles." The current v3 draft does that
  with a custom `address public admin` slot in both contracts.
- OpenZeppelin ships a higher-grade primitive for the single-admin pattern:
  **`AccessControlDefaultAdminRules`** (ACDAR). It enforces by construction
  three properties our custom `admin` slot only enforces by contract review:
  *single holder*, *two-step transfer with a per-admin delay*, and *delayed
  renounce*.
- **Recommendation:** use ACDAR on the **Controller** in place of the custom
  `admin` slot. Keep the custom approach on **IDRP** (the final v3 impl drops
  `AccessControlUpgradeable` entirely — see plan §2.1 — so ACDAR doesn't fit
  there without re-introducing the parent we're trying to delete).
- Net effect: Controller becomes more secure with less bespoke code; IDRP stays
  on the clean two-slot model (`admin` + `controller`) plus `upgrader`.

If you want a different recommendation (e.g. ACDAR on both, no ACDAR anywhere),
the trade-offs are spelled out below — this doc is for you to make the call.

---

## 1. Why we're even discussing this

The OZ docs explicitly call out the risk our refactor is trying to solve:

> "`DEFAULT_ADMIN_ROLE` is also its own admin: it has permission to grant and
> revoke this role. Extra precautions should be taken to secure accounts that
> have been granted it. We recommend using `AccessControlDefaultAdminRules` to
> enforce additional security measures for this role."
> — [OZ Contracts v5 — Access](https://docs.openzeppelin.com/contracts/5.x/api/access)

So OZ acknowledges plain `AccessControl` has a footgun (a compromised
`DEFAULT_ADMIN_ROLE` holder can grant the role to anyone else with no delay) and
ships ACDAR specifically to fix it. The v3 plan removes that footgun by removing
the role entirely. **The question is: does our custom `admin` slot re-create the
same footgun, just under a different name?**

Partly yes. With our current draft on the Controller:

```solidity
address public admin;
function setAdmin(address _admin) external onlyAdmin { admin = _admin; ... }
```

A compromised `admin` can instantly rotate to any other address. There is no
delay, no second confirmation, no on-chain notice. That's strictly worse than
ACDAR, which:

1. Requires a **two-step** transfer (`beginDefaultAdminTransfer` →
   `acceptDefaultAdminTransfer`) — the new admin must actively accept.
2. Enforces a **per-admin delay** between begin and accept (defaults to ~5 days,
   reducible via `changeDefaultAdminDelay`).
3. Requires the same delayed flow to **renounce** the role — no instant
   "burn the admin" by accident.
4. Guarantees by construction that **at most one account** holds the role at any
   time.

For a Safe-administered system the practical difference is smaller than it
sounds — the Safe's quorum already gates rotation — but it isn't zero. And it
costs us nothing semantic to use a battle-tested OZ primitive.

---

## 2. What ACDAR actually provides (vs. our custom `admin`)

| Property                                  | Custom `address admin` (current draft) | `AccessControlDefaultAdminRules` |
|-------------------------------------------|----------------------------------------|----------------------------------|
| Single holder enforced by code            | Indirectly (we just write `admin = …`) | **Yes, by construction**         |
| Two-step rotation (begin + accept)        | No                                     | **Yes**                          |
| Per-admin time delay on rotation          | No (we'd have to write a timelock)     | **Yes (configurable)**           |
| Cancel a pending rotation                 | N/A (rotation is instant)              | **Yes (`cancelDefaultAdminTransfer`)** |
| Delayed renounce                          | No                                     | **Yes**                          |
| Public view of pending change             | We'd have to add events/getters        | `pendingDefaultAdmin()`, `pendingDefaultAdminDelay()` |
| Audit familiarity                         | Bespoke (auditor reads our code)       | Standard OZ (auditor reads OZ)   |
| Bytecode cost                             | Tiny                                   | Modest (~few hundred bytes)      |
| Storage cost                              | 1 slot                                 | Several (incl. ERC-7201 namespace) |

The only thing ACDAR doesn't do for free is *make `admin` a Safe* — that's still
an off-chain ops decision (see [multisig-validation.md](./multisig-validation.md)).

---

## 3. Where ACDAR fits cleanly — and where it doesn't

### 3.1 Controller — fits well

The Controller already inherits `AccessControlUpgradeable` (we keep it for the
four quorum-signer roles). ACDAR is a drop-in replacement — it **extends**
`AccessControl`, just with stricter rules on `DEFAULT_ADMIN_ROLE`. So:

```solidity
// Before (current v3 draft on the Controller):
contract IDRPController is Initializable, AccessControlUpgradeable, UUPSUpgradeable { ... }
address public admin;
modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }

// After (proposed):
contract IDRPController is Initializable, AccessControlDefaultAdminRulesUpgradeable, UUPSUpgradeable { ... }
// `admin` slot deleted; rely on DEFAULT_ADMIN_ROLE (single-holder, two-step).
modifier onlyAdmin() { _checkRole(DEFAULT_ADMIN_ROLE); _; }
// Or just decorate each gated method with `onlyRole(DEFAULT_ADMIN_ROLE)`.
```

The four signer roles (`OFFICER_ROLE`, …) remain as-is. The `grantRole` /
`revokeRole` override (Option A in plan §2.2) keeps working: `_checkRole(
DEFAULT_ADMIN_ROLE, msg.sender)` is the new gate.

**One subtlety**: ACDAR makes `DEFAULT_ADMIN_ROLE` the role-admin of every other
role *by default* — exactly what we removed for security reasons. We need to
**keep the `grantRole`/`revokeRole` overrides** so the only entry point that
mutates the signer roles is the one gated by `_checkRole(DEFAULT_ADMIN_ROLE)`,
not the standard OZ flow. Otherwise we re-open the footgun.

### 3.2 IDRP — does NOT fit cleanly

The whole point of the IDRP refactor is to **remove `AccessControlUpgradeable`
entirely** (Option I, step B in the plan). ACDAR *is* an AccessControl
extension — adopting it on IDRP would *re-introduce* the import we're trying
to delete. We'd also lose the `controller` slot's clarity ("one address that is
the Controller, period") if we replaced it with a role.

So on IDRP I recommend keeping the custom slots:
- `address admin` — single-holder admin (Safe).
- `address controller` — single-holder operational entity (the Controller).
- `address upgrader` — single-holder upgrader (Safe).

This is the *cleanest* outcome for IDRP, which only needs three named
single-holder authorities and no enumerable role anywhere.

If we still want ACDAR-style guarantees on IDRP without re-importing
`AccessControlUpgradeable`, we can later **port the two-step + delayed-rotation
pattern by hand** for the three slots. That's roughly ~80 lines of code that
mirrors ACDAR's logic. Worth doing if/when the audit asks for it; not in scope
for v3.

---

## 4. The recommendation

> **Controller:** use `AccessControlDefaultAdminRulesUpgradeable` + the four
> quorum-signer roles + the overridden `grantRole`/`revokeRole`. Drop the custom
> `admin` slot.
>
> **IDRP:** keep the three custom slots (`admin`, `controller`, `upgrader`).
> Don't reintroduce `AccessControlUpgradeable` just to use ACDAR.

Rationale:
1. **Standard > bespoke** where the standard is a strict superset of what we
   need. ACDAR's two-step + delay is the headline mitigation OZ ships against
   the exact footgun the audit flagged.
2. **Familiar to auditors.** Less custom code on the highest-stakes role.
3. **No re-importing what we just removed.** Keeping ACDAR off of IDRP means the
   final v3 IDRP impl still drops `AccessControlUpgradeable` cleanly, which is
   the literal text of the note's goal.

---

## 5. Trade-offs and alternatives

### Alternative A: keep the current draft (no ACDAR anywhere)

- ✅ Simplest. Less moving parts. Same bytecode size.
- ❌ A compromised Controller `admin` can rotate to any address in one tx.
  Mitigation today: `admin` is a Safe, so this requires Safe quorum compromise.
- ❌ We carry forward the footgun OZ explicitly tells the world to avoid.

### Alternative B: ACDAR on both Controller and IDRP

- ✅ Strongest guarantees everywhere; consistent shape between the two contracts.
- ❌ Re-introduces `AccessControlUpgradeable` on IDRP — contradicts the note
  and the audit ask. Not recommended.

### Alternative C: ACDAR on Controller, hand-rolled two-step rotation on IDRP

- ✅ Same-strength guarantees on both contracts.
- ❌ Roughly +80 lines on IDRP that have to be tested. Acceptable but probably
  more than the audit needs right now.
- This is a good follow-up after v3 ships.

---

## 6. Storage / upgrade impact if we adopt ACDAR on the Controller

This is the part that needs the most care. ACDAR stores its state under an
**ERC-7201 namespace** in OZ v5 (`openzeppelin.storage.AccessControlDefaultAdminRules`).
Namespaced storage **does not collide with sequential storage slots**, so we can
adopt ACDAR on top of an existing `AccessControlUpgradeable` proxy *without*
shifting any existing variable.

The custom `admin` slot we already drafted (appended after `pendingQuorumRules`)
becomes orphaned bytecode — same situation as the deprecated Ownable namespace
on the Controller today. We'd:

- Remove the `admin` sequential slot from the v3 draft (or leave it declared
  with a `@custom:storage-location` deprecation comment if we want to be paranoid
  about future readers).
- Replace `onlyAdmin` with `onlyRole(DEFAULT_ADMIN_ROLE)`.
- `initializeV3` calls `__AccessControlDefaultAdminRules_init(delay, _admin)`
  *instead of* writing to a sequential slot. The role grant is the migration.
- Keep the overridden `grantRole` / `revokeRole`.

**This needs a fresh storage-preservation test against the existing
`IDRPControllerV1Mock`-style mock**, because we'd be moving from one OZ
namespaced parent to another. OZ Upgrades will refuse the upgrade if it can't
prove the layout is safe, which is exactly the property we want.

---

## 7. What needs to change in the existing v3 draft if we adopt this

(Only listed so you can see the full picture — no code yet, just a checklist
for after you approve.)

In `contracts/IDRPController.sol`:
- Replace `AccessControlUpgradeable` import with
  `AccessControlDefaultAdminRulesUpgradeable`.
- Delete the `address public admin` slot.
- Delete the `onlyAdmin` modifier; replace every site with
  `onlyRole(DEFAULT_ADMIN_ROLE)` (or equivalent).
- Adjust `initialize` and `initializeV3` to call
  `__AccessControlDefaultAdminRules_init(initialDelay, _safeAddress)`.
- Decide initial delay parameter (proposed: **48h**, same as `UPGRADE_DELAY`,
  so admin rotation has the same gravity as a proxy upgrade).
- Keep the `grantRole`/`revokeRole` overrides (still gated by
  `_checkRole(DEFAULT_ADMIN_ROLE)`).
- Update `setUpgrader` / `executeOperation` admin-allowed branch to use the
  role check instead of `msg.sender == admin`.

In tests:
- Replace `controller.connect(admin).setAdmin(...)` with the two-step ACDAR API.
- All V5-* tests that grant signer roles continue to work unchanged.

No change to IDRP.sol or its tests — IDRP stays on the custom-slot model.

---

## 8. Decision needed from you

Pick one:
1. **Adopt the recommendation** (ACDAR on Controller, custom slots on IDRP).
2. **Stay with the current v3 draft** (custom `admin` slot on both).
3. **Go all-in on ACDAR** (both contracts) — least recommended because it
   contradicts the "remove AccessControlUpgradeable from IDRP" goal.
4. **Defer** — ship v3 with the custom slot, add ACDAR/hand-rolled two-step in
   v4.

If (1), I update [plan.md](../../../../notes/features/idrp-contracts/on-progress/no-access-control/plan.md)
and re-do the Controller refactor (about ~30 lines change, plus tests). If (4),
nothing changes; we just record the decision.

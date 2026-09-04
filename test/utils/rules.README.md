# Quorum rules — source of truth

These JSON files are the canonical quorum configuration for `IDRPController`.
Tests import them directly (`import rules from "./rules.X.json"`) instead of
hardcoding tiers inline, and `scripts/set-mint-burn-quorum-rules.ts` seeds a
live chain from the same source. **If a quorum requirement changes, change it
here — do not hand-edit tiers inside a test file.**

## Schema

Each file is a JSON array of tier objects, applied via
`IDRPController.setQuorumRules(operationType, rules)`:

```json
{
  "minAmount": "0",
  "maxAmount": "500000000000000",
  "requiredRoles": ["0xbbec...", "0x241e..."]
}
```

- `minAmount` / `maxAmount` — decimal-string `uint256` bounds on the
  operation's `amount` parameter, expressed at IDRP's **6 decimals** (e.g.
  `"500000000000000"` = 500,000,000 IDRP). On-chain, a tier applies when
  `minAmount <= amount < maxAmount` (`getQuorumRule` in `IDRPController.sol`).
  For an operation where `amount` is not the effect (Freeze/Unfreeze/Pause),
  the bound is still evaluated against whatever `amount` the caller declares
  — see the tier-selection caveat on `rules.freeze.unfreeze.json` below.
- `requiredRoles` — a `bytes32[]` of role identifiers, each
  `keccak256("<ROLE_NAME>")` (verify with `cast keccak OFFICER_ROLE`, etc).
  `executeOperation` requires at least one valid signature per listed role
  (`verifySignatures` in `IDRPController.sol`); one signer can satisfy only
  one role, so `requiredRoles.length` is the minimum number of distinct
  signers. The four roles in this system:
  - `OFFICER_ROLE`      = `0xbbecb2568601cb27e6ced525237c463da94c4fb7a9b98ac79fd30fd56d8e1b53`
  - `MANAGER_ROLE`      = `0x241ecf16d79d0f8dbfb92cbc07fe17840425976cf0667f022fe9877caa831b08`
  - `DIRECTOR_ROLE`     = `0x15e007796fc034bf8274acdcfbd2f48124815698ba6f70c109f3423981a7052f`
  - `COMMISSIONER_ROLE` = `0xf40a29943eea2d5a1b57ac2700eb4e82e89f06c5825e85a2046bfcfb4eea28a7`

## Tier contiguity (enforced on-chain by `_validateQuorumRules`)

- Tiers must be sorted and gapless: tier `i`'s `minAmount` equals tier
  `i-1`'s `maxAmount`.
- The first tier's `minAmount` must be `"0"`.
- The last tier's `maxAmount` must be `type(uint256).max`, i.e.
  `"115792089237316195423570985008687907853269984665640564039457584007913129639935"`
  — every file in this directory ends on that literal.
- A single-tier file (`rules.pause.json`, `rules.unpause.json`,
  `rules.confiscate.json`) is the degenerate case of the same rule: one tier
  spanning `[0, max]`, so `amount` cannot select a weaker requirement.

## Files, by `OperationType`

| File | `OperationType` | Tiers | Notes |
|---|---|---|---|
| `rules.mint.burn.v2.json` | `Mint` (0), `Burn` (1) | 3 | Current mint/burn tiers — what `scripts/set-mint-burn-quorum-rules.ts` seeds on a live chain. Mint and Burn share one rule set. |
| `rules.mint.burn.v1.json` | `Mint` (0), `Burn` (1) | 4 | Superseded tier table (adds a lower Officer-only band below 100M). Kept for tests pinning the older shape; not what a live chain runs today. |
| `rules.mint.burn.json` | `Mint` (0), `Burn` (1) | 3 | Byte-identical to `rules.mint.burn.v2.json`; several existing test files import this name directly. |
| `rules.freeze.unfreeze.json` | `Freeze` (2), `Unfreeze` (3) | 4 | Both operations share this file. `amount` does not drive the Freeze/Unfreeze *effect* (`freeze(to)` / `unfreeze(to)` ignore it) — it only selects the tier, which is the open quorum-tier-bypass finding; see `test/security-audit/quorum-tier-bypass/QTB-01-AmountTierBypass.ts`. |
| `rules.pause.json` | `Pause` (4) | 1 (Manager + Director) | `to` and `amount` are both required to be unused/zero for Pause (`executeOperation`'s `to == address(0)` branch). |
| `rules.unpause.json` | `Unpause` (5) | 1 (all 4 roles) | Unpause is verified by a *different* function (`verifyUnpauseSignatures`, OR-combination logic: Officer+Manager+Director, OR Manager+Director+Commissioner). `requiredRoles` here is not consumed the way it is for every other op type, but the file is kept in the same shape for consistency, and `getQuorumRule` is still called first. |
| `rules.confiscate.json` | `Confiscate` (6) | 1 (all 4 roles) | Single top tier, any amount — deliberately structured so `amount` cannot select a weaker tier (same reasoning as Mint/Burn's tier-immunity: understating `amount` only under-confiscates). This file governs *who* may authorise a seizure. It says nothing about *where* seized funds go: seizures land in `IDRP.depositoryWallet`, the same address `mint` credits. The separate destination slot and its 48h timelock were removed, so the destination now moves with one instant `setDepositoryWallet` call by admin. Seeding this file is the single act that arms seizure on a chain. |

## Seeding a brand-new operation type is a single, un-timelocked transaction

`IDRPController.setQuorumRules` only takes the **instant** path when
`quorumRules[operationType].length == 0` — i.e. the first time an operation
type is configured. `Confiscate` (and any other new `OperationType`) is
seeded this way: one `setQuorumRules(Confiscate, rules)` call per chain, with
no 48h wait. The timelocked `scheduleQuorumRules` / `applyQuorumRules` path
only exists to **change** an op type that already has rules — it is not in
play for a first-time seed. Treat that initial call with the same care as
any other admin action that has no delay behind it.

## These files are the source of truth

Deploy scripts and tests both read from here. If a chain's live quorum rules
ever need to be audited or reproduced, start from the file matching its
`OperationType`, not from a test's inline literals.

# Operation: Refund — returning an unburned off-ramp deposit

**Status: DESIGN. Nothing built.** 2026-09-11.

Repos in scope: `idrp-contracts` (EVM + Tron), `idrp-contracts-solana`,
`stable-dashboard`. XRPL not in scope.

---

## Why this exists

The off-ramp custodies user funds in the controller, and there is no
quorum-gated way to give them back.

Both halves of that sentence are measured, not assumed:

- The off-ramp transfers the user's IDRP **to the controller**, not to a burn
  address — `src/app/app/(authed)/(home)/off-ramp/_content.tsx:315` approves and
  transfers to `controllerAddress`.
- It has to. `IDRP.burn` accepts `from` only when it is the calling controller
  itself or the configured `depositoryWallet` (`contracts/IDRP.sol:367`).
  A third party's balance is not burnable from that entry point — the
  burn-consent invariant. So "user transfers in, controller burns from itself"
  is the only shape the off-ramp can take.

Between the transfer-in and the burn, the controller holds real user money. The
burn does not always follow: the bank payout fails, a compliance hold lands, the
amount is wrong, the user cancels. Those tokens are then stranded in the
controller.

Today the only way to move them out is `withdrawToken`
(`contracts/IDRPController.sol:572`), which is `onlyRole(DEFAULT_ADMIN_ROLE)`.

That role was **not** removed by the v3 no-access-control refactor — v3
collapsed it to a single ACDAR holder. So the current exit from the controller's
IDRP balance is:

- one key,
- no quorum,
- no timelock,
- no operation-type audit trail,
- and it can move *any* ERC20 the controller holds, to *any* address.

`withdrawToken` is a sweeper for tokens accidentally sent to the contract. It is
being used — or would have to be used — as the refund path for user redemption
money. That is the wrong instrument at the wrong authority level.

**Refund is the right instrument: a TAP quorum operation, not an admin action.**

### Non-goal

This spec does not remove or narrow `withdrawToken`. It creates the
correct path first. Narrowing the admin sweeper (e.g. to reject `idrpToken`
once Refund is live on every chain) is a follow-up, listed under Future work.

---

## The design

### On-chain: a seventh operation type

```solidity
enum OperationType {
    Mint, Burn, Freeze, Unfreeze, Pause, Unpause,
    Confiscate,
    /// @dev Appended LAST so every existing value keeps its number — any
    ///      in-flight signature stays bound to the same operation.
    Refund
}
```

Appending is not cosmetic. `OperationType` is hashed into the EIP-712 operation
as `uint8`; inserting anywhere but the end re-points every unexecuted signature
at a different operation. Confiscate set this precedent and Refund follows it.

Execution branch in `executeOperation`:

```solidity
} else if (operationType == OperationType.Refund) {
    IERC20(idrpToken).safeTransfer(to, amount);
}
```

**The token contract is not touched.** Refund moves the controller's *own*
balance with a plain ERC20 transfer — no new token entry point, no
`onlyController` hook, no token upgrade. On EVM and Tron this is a
Controller-only upgrade. That is materially smaller than Confiscate, which
needed both contracts.

### Guards

In `executeOperation`, before signature verification:

```solidity
if (operationType == OperationType.Refund) {
    require(to != address(this), "Refund to self");
    require(
        amount <= IERC20(idrpToken).balanceOf(address(this)),
        "amount exceeds controller balance"
    );
}
```

1. `to != address(0)` — already enforced by the existing else-branch that covers
   every non-Pause operation.
2. `to != address(this)` — a self-refund is a no-op that burns a quorum's
   signatures and marks the operation hash used. Reject it.
3. `amount <= balanceOf(controller)` — an explicit revert rather than letting
   `safeTransfer` fail opaquely. It makes the cap legible at the revert site and
   in tests.

### What Refund deliberately does NOT inherit from Confiscate

**No `amount >= balanceOf(to)` escalation clamp.**

Confiscate carries that clamp because its *effect* is the target's entire
balance regardless of the `amount` argument — so `amount` is free to name a
small number and land in a cheap tier while the whole balance moves. That is the
quorum-tier-bypass finding, and the clamp plus single-tier enforcement is its
fix.

Refund's effect is exactly `amount`. Tier selection from `amount` is therefore
honest: naming a small amount produces a small refund. **Refund has no
tier-bypass exposure**, which is precisely why it is safe to tier it (see
below) where Confiscate is not.

**No `depositoryWallet` destination lock.**

Confiscate hard-codes its destination in token storage so a quorum can decide
*whether* a seizure happens but never *where* the funds go. Refund cannot do
that — the destination is a different user on every refund. The `to` argument is
quorum-chosen. See "Residual risk" below, which is the direct consequence.

---

## Quorum tiers

**DECIDED: launch single-tier, all four roles, any amount** — the same shape as
Confiscate's rule set.

```json
[
  {
    "minAmount": "0",
    "maxAmount": "<uint256 max>",
    "requiredRoles": [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE]
  }
]
```

Rationale: Refund is the one operation where the quorum names an arbitrary
destination for real money. Until the off-chain binding (below) is proven in
production, the full board signs every one. It is deliberately inconvenient.

Unlike Confiscate, this is **policy, not an invariant.** Do NOT add a
`require(rules.length == 1, "Refund must be single-tier")` to
`_validateQuorumRules`. Confiscate needs that require because `amount` cannot be
allowed to select a tier there. Refund can be re-tiered later through the normal
`scheduleQuorumRules` → 48h → `applyQuorumRules` path, with no contract upgrade.
Hard-coding single-tier would throw that away for no safety gain.

### Options for a later dynamic tier table

Recorded now so the re-tiering decision has grounded numbers. All use 6
decimals; the existing tables live in `stable-dashboard/src/lib/quorum.ts`.

**Option A — mirror Mint/Burn.** Refund returns money that was about to be
burned; the amount risk profile is identical to the burn that did not happen.

| Range (IDRP) | Roles |
|---|---|
| 0 – 500M | Officer + Manager |
| 500M – 1B | Officer + Manager + Director |
| 1B+ | all four |

**Option B — one notch stricter than Mint/Burn.** Refund names a destination;
Mint/Burn do not. Pay for that with one extra signer at every tier.

| Range (IDRP) | Roles |
|---|---|
| 0 – 500M | Officer + Manager + Director |
| 500M – 1B | all four |
| 1B+ | all four |

**Option C — low-friction floor, strict above it.** Most stranded off-ramp
deposits are retail-sized; a two-person tier under Rp 1M would let ops clear the
long tail without convening the board.

| Range (IDRP) | Roles |
|---|---|
| 0 – 1M | Officer + Manager |
| 1M – 500M | Officer + Manager + Director |
| 500M+ | all four |

Recommendation when the time comes: **Option C**, because the operational
failure mode of single-tier is that refunds queue up waiting for four
executives, and a queue of unreturned user money is its own compliance problem.
Revisit after the first quarter of real refund volume — the tier boundary should
be set from the observed amount distribution, not guessed.

**Per-chain reality check.** Tiers are NOT uniform across chains today — Polygon
thresholds are 10x lower than the others. The dashboard must read the live rule
via `getQuorumRule`, never render a hardcoded table.
`src/lib/quorum-onchain.ts` already does this correctly; the refund page uses
that path.

---

## Binding: where the safety actually lives

**DECIDED: off-chain binding.** On-chain, the quorum names `to` freely.

The contract cannot verify that `to` is the address that originally transferred
in. ERC20 has no receive callback, so the controller never observed the
transfer. Verifying it on-chain would require the off-ramp to call a
`depositForBurn()` entry point instead of a plain `transfer` — a change to
user-facing off-ramp UX, out of scope here (see Future work).

So the guarantee is enforced by the dashboard, and it must be enforced hard:

- **`to` is not a free-text field.** The operator selects an off-ramp
  `Transaction`; the UI derives `to` from `Transaction.address` — the wallet
  that transferred in. The page shows the transaction number, the inbound
  `transferTxHash`, the sender, and the amount. There is no address input to
  paste into.
- **`operationIdentifier` resolves to the transaction.** Note a trap here:
  `Transaction.operationIdentifier` is NOT a stable per-transaction key. It is
  rotated to a fresh UUID whenever a signature group is reopened, precisely so
  stale signatures from an abandoned group cannot be replayed
  (`src/server/api/routers/signature-group.ts:314`). It is also already spoken
  for by the burn operation.

  Refund therefore needs its **own** identifier, not a reuse of that column:
  a distinct value per refund attempt, rotated on group reopen exactly like the
  burn's, and recorded against the transaction so the event log resolves back to
  one off-ramp transaction. Reusing the burn's live `operationIdentifier` would
  collide the two operations' replay keys and let a rotation orphan the wrong
  signatures. This needs a schema addition — see Implementation notes.
- **`amount` defaults to the transaction amount and is capped by it.** The UI
  rejects a refund larger than what came in.
- **Eligibility is a status gate.** Only transactions in a refundable state can
  be selected: the inbound transfer confirmed, the burn not executed. A
  transaction whose burn already ran is not refundable — that money is gone from
  the controller and refunding it would pay the user twice.
- **`Transaction.refundNotes` / `refundProof` already exist** in the schema as
  the manual-refund record. They become the on-chain refund's record: proof
  becomes the refund tx hash.

### Residual risk — stated plainly

**A colluding four-role quorum can refund controller IDRP to an address they
control.** The contract cannot distinguish a legitimate refund from a theft,
because the destination is an argument.

Mitigating facts, none of which eliminate it:

- Four distinct roles must collude, which is the same bar as Confiscate.
- Every refund emits `OperationExecuted(Refund, to, amount, operationIdentifier)`
  and resolves to a named off-ramp transaction. A refund to an address that is
  not that transaction's sender is visible in the log immediately.
- The controller's IDRP balance is bounded by in-flight off-ramp volume, not by
  total supply.

This is accepted as the cost of not changing off-ramp UX. **It is strictly
better than the status quo**, where a single key can do the same thing with no
quorum and no operation-type trail.

The permanent fix is the on-chain deposit ledger, deferred to Future work.

---

## Chain parity

### EVM — `idrp-contracts`, branch off `main`

Controller-only upgrade.

- `OperationType.Refund` appended.
- Execute branch + guards as above.
- No change to `_validateQuorumRules` (Refund is not invariant-tiered).
- Tests in `test/refund/`, mirroring `test/confiscate/`:
  full quorum-authorised refund end-to-end; rejects insufficient signatures;
  rejects `to == address(0)`; rejects `to == controller`; rejects
  `amount > balanceOf(controller)`; replay of a used operation hash reverts;
  deadline enforcement; the existing six operations still execute unchanged.
- Storage layout check against real deployed mainnet bytecode on a fork —
  adding an enum value adds no storage, so this must come back clean; run it as
  proof, not as a formality.

### Tron — `idrp-contracts`, `tron` branch (OZ4 lineage)

Same source, ported to the OZ 4.9.6 pin.

**Sequencing is a hard constraint, not a preference.** Refund stacks a second
undeployed Controller upgrade behind Confiscate, on a lineage where the Nile
Controller has already been bricked once by a bad implementation. Refund is
ported and deployed **after** Confiscate lands on Nile, never in parallel, never
bundled into one upgrade.

Branch discipline: the `tron` branch, NOT `tron-confiscate-oz4`.

Atomic `upgradeToAndCall` only — never a split upgrade.

### Solana — `idrp-contracts-solana`

- New `OperationType` variant appended in `programs/*/src/operation.rs`.
  Discriminants are append-only for the same signature-binding reason as EVM.
- New arm in `instructions/execute_operation.rs`: SPL transfer from the
  controller's ATA to the destination ATA.
- The destination ATA must be bound to the signed `to` — the Critical finding
  from the 2026-07 audit was a signed `to` not bound to `target_ata`. That exact
  mistake is available again here. Assert the ATA derives from the signed
  destination.
- Tests mirroring the EVM set, plus the ATA-binding negative case.

### Dashboard — `stable-dashboard`

- `/controller/refund` page, modelled on the freeze/confiscate pages.
- Entry point is the off-ramp transaction list filtered to refundable states,
  not an address form.
- tRPC router + signature-group flow reusing the existing quorum machinery.
- Tiers read live from chain via `src/lib/quorum-onchain.ts`.
- `OperationType.Refund` added to `src/lib/quorum.ts`.
- On success, write the refund tx hash to `Transaction.refundProof` and move the
  transaction to its refunded terminal state.

#### Implementation notes — dashboard

- **Schema addition: a refund operation identifier.** Per the binding section,
  refund cannot share `Transaction.operationIdentifier` with the burn. Add a
  nullable `refundOperationIdentifier String? @unique` to `Transaction`,
  populated when a refund signature group opens and rotated on reopen, mirroring
  how `signature-group.ts` already handles the burn's. Additive migration, no
  backfill.
- **`SignatureGroup` must distinguish operation types.** The refund group and
  the burn group can both exist against one transaction. Confirm before building
  whether `SignatureGroup` already carries an operation-type discriminator; if
  not, that is a second additive column, and the "one open group per
  transaction" logic in `signature-group.ts` becomes "one open group per
  (transaction, operation type)".
- **Refundable-state gate.** The eligible statuses must be enumerated against
  the real `TransactionStatus` enum during planning, not guessed. The rule is:
  inbound transfer confirmed, burn not executed.

---

## Rollout order

1. EVM contract + tests, green.
2. Dashboard refund page against a local/testnet EVM deployment.
3. Solana program + tests.
4. Testnet rehearsal, all stacks — full quorum, real signatures.
5. Mainnet EVM: schedule → 48h → execute; seed the single-tier Refund rule.
6. Tron, **after Confiscate has landed on Nile.**

Seeding the rule: Refund has never been configured, so
`quorumRules[Refund].length == 0` and `setQuorumRules` applies instantly. Every
later change goes through the 48h `scheduleQuorumRules` path.

---

## Future work

- **On-chain deposit ledger.** Off-ramp calls `depositForBurn()` instead of
  `transfer`; the controller credits `deposits[sender] += amount`; Refund
  requires `amount <= deposits[to]` and decrements. This removes the residual
  risk entirely — the quorum could then only return funds to someone who
  actually deposited. Requires an off-ramp UX change (approve + call, instead of
  a plain transfer) and a token/controller storage addition.
- **Narrow `withdrawToken`** to reject `idrpToken` once Refund is live
  everywhere, so the admin sweeper can no longer touch user redemption money.
- **Partial refunds.** The current design refunds up to the transaction amount
  in one operation. Whether multiple partial refunds against one transaction
  should be allowed is unresolved. It is not forbidden by the contract — each
  refund carries its own identifier and its own quorum — but the dashboard's
  cap ("refund at most what came in") would need to track a running total
  rather than compare against the transaction amount once.

---

## Open questions

None blocking the contract work. The tier table is a policy decision recorded
above with three costed options; the residual risk is accepted and documented;
the deposit ledger is explicitly deferred.

Two dashboard items must be **measured during planning**, not assumed:

1. Does `SignatureGroup` already carry an operation-type discriminator? The
   answer decides whether refund needs one additive column or two.
2. Which `TransactionStatus` values are refundable? Enumerate from the enum.

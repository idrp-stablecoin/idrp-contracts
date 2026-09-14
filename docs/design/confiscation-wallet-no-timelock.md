# The confiscation destination is its own wallet, and its setter has no timelock

**Status:** decided 2026-09-09, recorded 2026-09-12.
**Supersedes:** the 2026-09-04 decision to send seized funds to `depositoryWallet`.
**Also supersedes:** the original design in which the destination sat behind a 48h timelock.

## What the design is

`confiscate(from, amount)` sends to a dedicated `confiscationWallet`. That address is set by
`setConfiscationWallet(address)`, which is `onlyAdmin` and takes effect immediately — the same
shape as `setDepositoryWallet` and `setSanctionsList`.

`depositoryWallet` keeps its existing, separate role. Seized funds and ordinary reserve flows
land in different wallets, which is the point: a seizure is a legal action whose proceeds must
be auditable as such, not mixed into the reserve account that backs circulating supply.

## Why the destination is separate again

Routing seizures into the depository made one implementation to deploy and removed three
storage slots, which is why it was chosen. It also merged two things that are different in
kind. Reserve attestation covers the depository; a seizure is custody of third-party funds
pending legal direction. Mixing them means every attestation has to net seizures out, and any
confiscation dispute implicates the reserve account. A dedicated wallet keeps the two ledgers
separable without changing the quorum that authorises the seizure.

## Why there is no timelock on the setter

The earlier design gated the destination behind the 48h `UPGRADE_DELAY` with
`scheduleConfiscationWallet` / `applyConfiscationWallet` / `cancelConfiscationWallet`. That is
being dropped deliberately, for four reasons.

**1. The setter cannot cause a seizure.** `confiscate` is `onlyController`, reachable only
through the Controller's quorum path. For `OperationType.Confiscate` the rules are validated
at write time to a single tier (`_validateQuorumRules` rejects a multi-tier set for that op),
so a caller cannot name a small `amount` to select a cheaper quorum — every seizure needs all
four roles. Changing the destination only redirects a seizure the quorum has already approved.
It is a routing parameter, not an authorisation one.

**2. A timelock makes the emergency case worse, not better.** If the confiscation wallet's
keys are compromised, the correct response is to repoint it in one transaction. A 48h delay
means either two days during which every approved seizure is paid into a wallet known to be
compromised, or suspending seizures entirely for two days. This is the same reasoning already
applied to `setSanctionsList`, which is deliberately un-timelocked so a misbehaving list can be
detached immediately.

**3. A timelock does not constrain a hostile `admin` anyway.** The same `admin` can call
`setController`, `setDepositoryWallet` and `setSanctionsList`. Delaying one address field buys
observation time, not prevention — and only for whoever is watching. The real control is
custody of `admin` plus monitoring; `ConfiscationWalletUpdated` is emitted so an alert can fire
on any change.

**4. Consistency with the audited precedent.** `setDepositoryWallet` has been the confiscation
destination setter since 2026-09-04 with no timelock, and went through audit in that shape.
`confiscationWallet` is the same class of parameter. Timelocking one destination setter and not
the other would be inconsistent without a reason, and the reason does not exist.

So the security boundary is deliberately placed at **who `admin` is**, not at a delay.

## ⛔ Precondition that is NOT met today

The argument above holds only where `admin` is a multi-party account. **Measured on-chain
2026-09-12:**

| chain | token `admin()` | custody |
|---|---|---|
| Ethereum | `0xb2480df5…1779` | **EOA — single key** |
| Polygon | `0xb2480df5…1779` | **EOA — single key** |
| BSC | `0xb2480df5…1779` | **EOA — single key** |
| Kaia | `0xb2480df5…1779` | **EOA — single key** |
| Base Sepolia | `0xae2e7767…4279` | Safe 3-of-5 (v1.4.1) |
| Kairos | `0xe30650aa…a42e` | Safe 3-of-5 (v1.4.1) |

All four production chains share one externally-owned key, so on mainnet today a single
signature can redirect the confiscation destination — and that key is the same one that can
`setController`. The no-timelock design is sound on the testnets, where `admin` is a 3-of-5
Safe. **Moving `admin` to a multisig on all four mainnets is therefore a precondition for
shipping confiscate to production, not a follow-up.** Adding a timelock instead would not fix
this; it would only delay a single-key action by 48h while leaving every other single-key
action untouched.

## Storage

`confiscationWallet` is appended after the existing variables so no live slot moves. Verified
2026-09-12 that the target word is zero on every token proxy — all four EVM mainnets plus both
EVM testnets read `0x0` at slot 9, and the Tron layout is free from 511 up. The retired
placeholders from the earlier design were deleted and the dirty slots scrubbed by
`initializeV4()`, so nothing stale is inherited.

Confirm against the compiler's own `storageLayout` output before deploying, and diff the whole
layout positionally rather than spot-checking names — `__gap` and `_name` each appear more than
once, so name-matching silently compares the wrong entries.

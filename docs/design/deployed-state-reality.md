# Deployed State — Ground Truth Per Chain

> Authoritative, RPC-verified snapshot of what's actually deployed on each
> production and testnet proxy. **This doc supersedes any earlier claim about
> v2 not being deployed.**
>
> Verified: 2026-06-02 by direct RPC `eth_call` against the addresses in
> [`deployment/chain-*.json`](../../deployment/) on two independent RPCs per chain.
>
> The first version of this analysis used the wrong selector for `upgrader()`
> (`0xf72c0d8b`, which is actually `UPGRADER_ROLE()`). The correct selector is
> **`0xaf269745`**. Section 5 is a postmortem of that mistake so we don't
> repeat it.

---

## 1. TL;DR

- **Production chains (Ethereum, Polygon, BSC, Kaia) ARE on partial v2.** All
  four IDRP proxies and all four Controller proxies have the v2 `upgrader` slot
  populated with the SAME address: `0xb2480DF57396569f93D8a71203546066B66c1779`.
  The v1 `UPGRADER_ROLE` has been revoked (as designed by `initializeV2`).
- **But the deployed v2 is an EARLY draft** — it lacks the 48h timelock state
  (`UPGRADE_DELAY`, `scheduledImplementation`, `upgradeScheduledAt`), the
  sanctions-list addition, and the post-v2 quorum-role split
  (OFFICER/MANAGER/DIRECTOR/COMMISSIONER). Whatever shipped as "v2" on mainnet
  was a strict subset of what `main` calls v2 today.
- **Therefore: `initializeV3` CAN be gated by `onlyUpgrader` on production**
  (the slot is populated; the migration tx is signed from
  `0xb2480DF5…c1779`). The earlier "must use DEFAULT_ADMIN_ROLE" argument was
  based on the wrong-selector probe.
- **Testnets are inconsistent.** Sepolia and Kaia Kairos IDRP are still on v1.
  Each chain must be checked individually before migration.

---

## 2. The chain-by-chain matrix (verified 2026-06-02)

Notation: `✅` = method exists in deployed bytecode, `❌` = reverts (not in bytecode).

### IDRP proxies

| Chain                  | `upgrader()`                               | `UPGRADER_ROLE()` | `UPGRADE_DELAY` | `scheduledImpl`/`upgradeScheduledAt` | `sanctionsList` | `depositoryWallet` |
|------------------------|--------------------------------------------|:---:|:---:|:---:|:---:|:---:|
| Ethereum (1)           | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ❌  | ❌  | ✅ |
| Polygon (137)          | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ❌  | ❌  | ✅ |
| BSC (56)               | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ❌  | ❌  | ✅ |
| Kaia (8217)            | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ❌  | ❌  | ✅ |
| Sepolia (11155111)     | ❌                                          | ✅  | ❌  | ❌  | ❌  | (n/a) |
| Kaia Kairos (1001)     | ❌                                          | ✅  | ❌  | ❌  | ❌  | (n/a) |
| Base Sepolia (84532)   | ✅ (testnet upgrader set)                  | ❌  | ❌  | ❌  | ❌  | (n/a) |
| Holesky (17000) / Holesky-2 | ❌                                     | ?   | ❌  | ❌  | ❌  | (n/a) |

### Controller proxies

| Chain                  | `upgrader()`                               | `UPGRADE_DELAY` | `OFFICER_ROLE` | `ADMIN_ROLE` | `nonce()` |
|------------------------|--------------------------------------------|:---:|:---:|:---:|:---:|
| Ethereum (1)           | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ✅  | ✅ `6` |
| Polygon (137)          | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ✅  | ✅ `5094` |
| BSC (56)               | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ✅  | ✅ |
| Kaia (8217)            | ✅ `0xb2480DF5…c1779`                       | ❌  | ❌  | ✅  | ✅ `2524` |
| Sepolia (11155111)     | ❌                                          | ❌  | ❌  | ✅  | ?   |
| Kaia Kairos (1001)     | ✅ (testnet upgrader set, different from mainnet)           | ❌  | ❌  | ✅  | ?   |
| Base Sepolia (84532)   | ❌                                          | ❌  | ❌  | ✅  | ?   |

---

## 3. What this tells us about the deployed "v2"

The deployed v2 implementation is **`initializeV2` + the `upgrader` slot + role
cleanup, and NOTHING ELSE from what we now call v2 in source**. Specifically it
LACKS:

| Feature in current source `main` | Present on prod? |
|---|:---:|
| `upgrader` single-address slot                       | ✅ |
| `initializeV2` migration                              | ✅ (already ran) |
| Revocation of legacy `UPGRADER_ROLE`                  | ✅ |
| 48h `UPGRADE_DELAY` constant                          | ❌ |
| `scheduledImplementation` + `upgradeScheduledAt`      | ❌ |
| `scheduleUpgrade` / `cancelUpgrade` timelock workflow | ❌ |
| `sanctionsList` slot + override in `_update`          | ❌ |
| `permit()` freeze override (SC-07)                    | ❌ (052026 audit, not yet on prod) |
| SC-06 `setDepositoryWallet` same-wallet guard          | ❌ (052026 audit) |
| OFFICER/MANAGER/DIRECTOR/COMMISSIONER quorum roles    | ❌ |
| `usedSignatures[hash]` + `operationIdentifier` replay | ❌ (Controller still uses `nonce`) |
| SC-05 quorum-rule timelock (`scheduleQuorumRules`…)   | ❌ (052026 audit) |

So the production state is the **`upgrader` skeleton without the timelock or
anything built on top of it.** Functionally an `upgrader` slot that doesn't yet
enforce a delay — just a single-address upgrade authority.

**`upgrader = 0xb2480DF5…c1779`** is the address that signs upgrades on
production today.

---

## 4. Implications for v3 migration

### 4.1 `initializeV3` gating

Both options now work on production:

- **Option A — `onlyUpgrader`** (what your intuition wanted). Mainnet `upgrader`
  is populated and the same on all four chains, so the migration tx is signed
  by `0xb2480DF5…c1779`. **This is now the simpler, cleaner choice.**
- **Option B — `onlyRole(DEFAULT_ADMIN_ROLE)`.** Still works as a fallback;
  also matches the earlier audit MINOR-1/MINOR-2 pattern (`initializeV2` used it for
  the same reason). Slightly more conservative if `upgrader` ever turned out to
  be incorrect on one chain.

**Recommended switch:** gate `initializeV3` by `onlyUpgrader` on both contracts.
The argument in [`initializeV3-gating.md`](./initializeV3-gating.md) is wrong
about the production state of `upgrader` — see §5 below for what to correct.

Trade-off if we switch:
- ✅ Aligns with the original intent (v2 introduced `upgrader` specifically to
  be *the* upgrade authority).
- ✅ Matches the actual deploy workflow (upgrade tx and `initializeV3` body
  authorized by the same address — clean).
- ✅ Testnets that haven't run `initializeV2` (Sepolia, Kairos IDRP) need their
  v1→v2 migration to be re-run before v3. That's an ops sequencing issue, not
  a contract issue, and we have the existing `upgrade.ts` v1→v2 path for it.

### 4.2 Storage layout & test mocks

Production has the `upgrader` slot but NONE of the timelock storage that comes
after it in current source. So:

- The plan's draft of appending new v3 slots after `pendingQuorumRules` is
  **wrong against prod**, because `pendingQuorumRules` isn't on prod.
- We need a `IDRPV2Mock` (and `IDRPControllerV2Mock`) that matches the actual
  deployed v2 — only the `upgrader` slot, no timelock state, no sanctionsList.
- Storage-preservation tests must cover the path
  `prod-partial-v2 → v3` directly, NOT `current-source-v2 → v3`.

### 4.3 Testnet remediation

Sepolia, Kairos (IDRP only), Holesky: still on v1 (`UPGRADER_ROLE` exists,
`upgrader()` reverts). To bring them onto v3:

1. Run the existing v1→v2 migration first (`scripts/upgrade.ts` in its v1→v2
   branch). This is the same script that was run on prod long ago.
2. Then run v3 migration.

Or, equivalently, we could write a `initializeV3` that **detects current state**
and handles both jumps (v1→v3 directly, or partial-v2→v3). Cleaner UX but more
contract code; less safe than two explicit steps.

---

## 5. Postmortem — the wrong-selector bug

I claimed across multiple earlier docs that "v2 was never deployed" and that
"`upgrader()` reverts on all production chains." Both claims were based on
calls to selector **`0xf72c0d8b`**.

`0xf72c0d8b` is actually the function selector for `UPGRADER_ROLE()` (the v1
`bytes32 public constant` getter). The selector for `upgrader()` (the v2
`address public` getter) is `0xaf269745`. They're entirely different functions
on entirely different versions.

When I probed prod with `0xf72c0d8b`:
- v2-deployed proxies reverted (correct! the role was removed by `initializeV2`).
- v1 proxies returned the role hash `0x189ab7a9…d2e3` (= `keccak256("UPGRADER_ROLE")`).

I read the v2 reverts as "`upgrader` slot doesn't exist" — but they actually
meant "`UPGRADER_ROLE` constant doesn't exist", which is the *opposite* signal:
that role was *removed* during the v2 migration.

The fix is mechanical:
- Always derive selectors via `ethers.id('fn(args)').slice(0,10)` and double-check
  the function actually exists in source before drawing conclusions from a
  revert.
- Probe both the "v1 surface" (e.g. `UPGRADER_ROLE()`) AND the "v2 surface"
  (e.g. `upgrader()`) and interpret the **combination**, not just one.

### Docs that need correcting

1. **[`initializeV3-gating.md`](./initializeV3-gating.md)** — entire premise was
   "upgrader doesn't exist on prod, so we must use DEFAULT_ADMIN_ROLE." False.
   The correct framing is "upgrader DOES exist on prod, so we can use
   `onlyUpgrader`; DEFAULT_ADMIN_ROLE is a fallback for testnets that haven't
   yet been v2-migrated." I'm leaving the file in place and adding a STATUS
   banner at the top so future readers see the correction.

2. **[`upgrade-versions-timeline.md`](./upgrade-versions-timeline.md)** — the
   "production state at the time of writing" table claimed `upgrader()`
   reverts on prod. Wrong. Same banner correction.

3. **`plan.md`** (in `notes/features/idrp-contracts/on-progress/no-access-control/`)
   — §3 "production reality" section was based on the same probe. Needs update.

4. **`UPGRADE_HISTORY.md`** — was missing the `initializeV2` rows for each prod
   chain. They DID happen; the log was stale. We should add them when we know
   the tx hashes (or mark them as "pre-existed, exact tx not recorded").

I'll apply the corrections in a separate pass so this doc and the actual
correction-to-source can be reviewed together.

---

## 6. Action items derived from this finding

- [ ] Add a `STATUS: superseded` banner to `initializeV3-gating.md` pointing
      readers here.
- [ ] Add a corrected "production state" section to
      `upgrade-versions-timeline.md` based on the verified table in §2.
- [ ] Update `plan.md §3` to reflect that `onlyUpgrader` is viable on prod.
- [ ] Add `initializeV2`-execution rows to `docs/upgrade-history/UPGRADE_HISTORY.md`
      for each chain (need tx hashes from the actual on-chain history).
- [ ] Write `IDRPV2Mock.sol` and `IDRPControllerV2Mock.sol` that match the
      EARLY-DRAFT v2 actually deployed (upgrader slot only; no timelock; no
      sanctionsList; no quorum-role split). Storage-preservation tests use
      these as the v2 fixture.
- [ ] When re-refactoring the Controller to ACDAR, switch `initializeV3` from
      `onlyRole(DEFAULT_ADMIN_ROLE)` to `onlyUpgrader` (or keep both gates with
      OR for testnet flexibility — TBD).
- [ ] Write `scripts/list-default-admin-holders.ts` AND
      `scripts/check-contract-state.ts` enhancement so per-chain pre-migration
      verification is automated.

---

## 7. The deployer / upgrader address itself

All four prod chains share **`upgrader = 0xb2480DF57396569f93D8a71203546066B66c1779`**.

We have not yet verified that this address is a Safe (vs. an EOA). Block
explorers and Safe Transaction Service can confirm. **This MUST be checked
before any v3 migration tx is signed** — see
[`multisig-validation.md`](./multisig-validation.md) for the off-chain
verification process.

If `0xb2480DF5…c1779` is a Safe with the agreed M-of-N quorum: proceed.
If it's an EOA: the migration is still possible but introduces a single-key
risk; consider rotating to a Safe via `setUpgrader` first.

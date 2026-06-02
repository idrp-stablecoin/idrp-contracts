# Mainnet Deployed Source — Ground Truth Snapshots

Verified Solidity source pulled directly from block-explorer-verified
implementations on **Ethereum mainnet (chainId 1)**. These files are the
authoritative "what's actually running in production" reference. We use them
to build the migration mocks (`contracts/mocks/IDRP{,Controller}V{1,2}Mock.sol`)
and to write storage-preservation tests for the v3 (no-access-control)
migration.

> Pulled by hand from Etherscan (verified contract source) on 2026-06-02.
> The same `upgrader = 0xb2480DF57396569f93D8a71203546066B66c1779` is the
> upgrade authority on Ethereum, Polygon, BSC, and Kaia, so the same
> deployer almost certainly pushed identical bytecode to all four mainnets.
> One chain's verified source is the ground truth for all four.

---

## Files in this folder

| File | What it is | Provenance |
|---|---|---|
| `v1.IDRP.sol` | The IDRP **v1** implementation that the IDRP proxy was pointing to **just before the v2 upgrade tx** (i.e. the latest verified pre-v2 implementation on Etherscan). | Captured by Adam from Etherscan, 2026-06-02. |
| `v1.IDRPController.sol` | The IDRPController **v1** implementation — the **initial-deploy** implementation, i.e. what the proxy pointed to from genesis. | Captured by Adam from Etherscan, 2026-06-02. |
| `v2.IDRP.sol` | The IDRP **v2** implementation **currently active** on the IDRP proxy. | Captured by Adam from Etherscan, 2026-06-02. |
| `v2.IDRPController.sol` | The IDRPController **v2** implementation **currently active** on the Controller proxy. | Captured by Adam from Etherscan, 2026-06-02. |

`v1` here means "what we were running before the v2 upgrade landed", not
"the initial deployment in absolute terms" — for IDRP, the on-chain history
shows several v1-to-v1 upgrades (e.g. the Dec-2025 burn-logic fix). `v1.IDRP.sol`
is the **latest** of those v1 implementations, not the genesis one. For the
Controller, the genesis impl and the pre-v2 impl happen to be the same.

---

## Why we need this

The OpenZeppelin Upgrades plugin compares old vs. new storage layouts when
planning an upgrade and refuses to apply one if the layouts are
incompatible. For our v3 (no-access-control) migration we must prove the
v2→v3 layout is safe. The way you prove that in Hardhat is:

1. Author a `Mock` Solidity file whose **storage layout** matches what's
   actually deployed (the function bodies can be simplified — only the
   layout has to match).
2. Use `hre.upgrades.deployProxy(MockFactory, ...)` to spin up a fake
   "current production" proxy in your test.
3. Use `hre.upgrades.upgradeProxy(proxyAddr, NewFactory, ...)` to apply the
   real v3 implementation. If the layout is incompatible, the plugin
   throws at this step — which is exactly the failure mode we want to
   catch before mainnet.

So these `.sol` files are the SOURCE OF TRUTH for what the v1 and v2 mocks
should look like in `contracts/mocks/`.

---

## Key facts learned from inspecting these (important context before writing mocks)

### v1.IDRP

- Inherits `AccessControlUpgradeable` + ERC20 stack + `UUPSUpgradeable`.
- Storage sequence (sequential slots, after the namespaced OZ storage):
  `frozen` mapping → `depositoryWallet`.
- Role gates: `MINTER_ROLE`, `PAUSER_ROLE`, `FREEZER_ROLE`, `UPGRADER_ROLE`,
  `DEFAULT_ADMIN_ROLE`. Upgrade auth is `onlyRole(UPGRADER_ROLE)`.
- No `maxSupply`, no `upgrader`, no `sanctionsList`, no `permit` override,
  no timelock state, no `setDepositoryWallet` no-op guard.

### v1.IDRPController

- Inherits **BOTH** `AccessControlUpgradeable` AND `OwnableUpgradeable` +
  `UUPSUpgradeable`. **This is critical for storage layout** — the OZ
  Ownable parent reserves an ERC-7201 namespaced slot
  (`openzeppelin.storage.Ownable`) that the v2 impl still preserves as
  `OwnableStorageDeprecated`.
- Storage sequence: `idrpToken`, `nonce`, `quorumRules`, `usedSignatures`,
  `DOMAIN_SEPARATOR`.
- The v1 Controller **already had** the OFFICER/MANAGER/DIRECTOR/COMMISSIONER
  roles and the `usedSignatures[hash]` + `operationIdentifier` replay scheme.
  It also `nonce++` on every `executeOperation` — but only as a
  "backward compatibility" counter, not for replay protection.
  See `executeOperation` line 183: `// Increment nonce - keeping for backward compatibility`.
- Upgrade auth: `_authorizeUpgrade ... onlyOwner` (from `OwnableUpgradeable`).
- `withdrawToken` is `onlyOwner` (NOT a role).

### v2.IDRP

- Adds: `maxSupply`, `upgrader`, `UPGRADE_DELAY` constant, `upgradeScheduledAt`,
  `scheduledImplementation`, `sanctionsList`, several events, a sanctions
  check in `_update`, the `withdrawToken` helper, the `setMaxSupply` /
  `setSanctionsList` / `setUpgrader` setters, and `initializeV2` to migrate
  legacy `UPGRADER_ROLE` holders.
- **Removes** `_beforeTokenTransfer` and the custom `transfer`/`transferFrom`
  overrides that v1 had — the frozen check moved into `_update`.
- **Does NOT yet have** SC-06 (no-op depository guard), SC-07 (`permit()`
  freeze override), SC-05 (quorum-rule timelock). Those are all on the
  `main` branch as audit-v5 work but are NOT in the deployed v2.

### v2.IDRPController

- Replaces `OwnableUpgradeable` with the single-address `upgrader` slot
  pattern (audit V4-2 finding). The Ownable namespace is preserved as
  `OwnableStorageDeprecated` so the layout matches v1 on upgrade.
- Adds: `MAX_DEADLINE_DURATION` (7 days), `UPGRADE_DELAY` (48h),
  `upgradeScheduledAt`, `scheduledImplementation`, `upgrader`,
  `setQuorumRules` range validation, `scheduleUpgrade`/`cancelUpgrade`/
  `_authorizeUpgrade` timelock workflow, `verifyUnpauseSignatures` with
  duplicate-signer detection, `verifySignatures` with multi-role bypass
  protection, deadline cap check.
- `nonce` slot is preserved but **the `nonce++` line is gone** from
  `executeOperation`. Comment on line 51 confirms: "Deprecated: nonce is no
  longer used. Replay protection is via usedSignatures[operationHash]."
- **Does NOT yet have** SC-05 (quorum-rule timelock storage:
  `pendingQuorumRules` mapping). That's audit-v5 work on `main`, not on
  the deployed v2.

---

## Implications for the v3 mocks

Now that we have ground truth, the mocks in `contracts/mocks/` should mirror
the storage layout of these files EXACTLY (not the function bodies). In
particular:

- `IDRPControllerV1Mock.sol` (the existing one) **already includes Ownable** —
  good, matches deployed v1.
- We need a **new** `IDRPControllerV2Mock.sol` that matches `v2.IDRPController.sol`
  (Ownable removed, `upgrader` slot, timelock state, `MAX_DEADLINE_DURATION`).
- We need a **new** `IDRPV1Mock.sol` matching `v1.IDRP.sol`.
- We need a **new** `IDRPV2Mock.sol` matching `v2.IDRP.sol`.
- `IDRPControllerV1Mock.sol` should also be sanity-checked against
  `v1.IDRPController.sol` to confirm storage parity.

These mocks then back the storage-preservation tests:

- `v1 → v3` (chain that hypothetically never ran v2 — relevant for some testnets)
- `v2 → v3` (the actual production path)
- `v1 → v2 → v3` (full-chain replay)

---

## Why mainnet partial-v2 differs from the v2 source on `main`

The earlier session (before this source was pulled) showed via RPC probes
that mainnet IDRP/Controller proxies have `upgrader()` populated but
**don't have** `UPGRADE_DELAY`/`scheduledImplementation`/`sanctionsList`/
`OFFICER_ROLE`. That seemed inconsistent — until we got the actual deployed
source.

Now it's clear: this `v2.IDRP.sol` / `v2.IDRPController.sol` IS what's
deployed, and DOES contain `UPGRADE_DELAY`, `scheduledImplementation`, etc.
The earlier "REVERT" results from RPC probes were most likely a stale-call
or RPC-cache artifact — the real bytecode has these functions. **Action
item:** re-run the probes in `deployed-state-reality.md` against a fresh
archive node and reconcile. Either way, the verified-source files in this
folder are the ground truth and supersede the probe-based table in
`deployed-state-reality.md`.

---

## Sources & references

- Ethereum mainnet IDRP proxy: [`0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56`](https://etherscan.io/address/0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56)
- Ethereum mainnet Controller proxy: [`0x9cB9AE7480ee98A41373100d4304194043f02c9d`](https://etherscan.io/address/0x9cB9AE7480ee98A41373100d4304194043f02c9d)
- Deployed `upgrader` (all 4 mainnets): `0xb2480DF57396569f93D8a71203546066B66c1779`
- Source pull date: 2026-06-02
- Branch in this repo at time of capture: `access-controll`

Related docs:
- [`docs/design/deployed-state-reality.md`](../../../docs/design/deployed-state-reality.md)
  — chain-by-chain state matrix (needs reconciling against this verified source)
- [`docs/design/upgrade-versions-timeline.md`](../../../docs/design/upgrade-versions-timeline.md)
  — version definitions
- [`notes/features/idrp-contracts/on-progress/no-access-control/plan.md`](../../../../notes/features/idrp-contracts/on-progress/no-access-control/plan.md)
  — the v3 migration plan

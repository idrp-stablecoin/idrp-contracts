# `scripts/v1-to-v2/` — Testnet remediation: v1 → v2

> Special-purpose one-shot scripts that migrate a v1 proxy to the **legacy
> v2 implementation** (`contracts/legacy/IDRPv2.sol` /
> `IDRPControllerv2.sol`). Use only on testnets that never ran the v2
> migration historically. After this step the testnet looks like every
> production chain (partial-v2, with `upgrader` populated) and can be
> migrated to v3 via the normal top-level `scripts/`.
>
> ⚠ DO NOT run these scripts on mainnet — every mainnet is already at v2.

---

## When to use this

Per the verified state matrix in
[`docs/design/v3-rollout-plan.md`](../../docs/design/v3-rollout-plan.md#2-live-state-of-all-our-chains-verified-2026-06-02):

| Testnet            | IDRP | Controller | What this folder does |
|--------------------|---|---|---|
| Base Sepolia (84532)  | already v2 | **v1 — needs migration** | Run Controller scripts only |
| Kaia Kairos (1001)    | **v1 — needs migration** | already v2 | Run IDRP scripts only |
| Tron Nile             | (verify via TronWeb) | (verify via TronWeb) | If v1, run TRON-specific tooling |
| Sepolia, Holesky      | both v1, not in scope | both v1, not in scope | Leave alone; decommission separately |

Run `npx hardhat run scripts/check-contract-state.ts --network <name>`
first to confirm the version. If `upgrader()` reverts on the proxy
you're targeting, it's at v1 and this folder applies.

---

## Files

| File | Purpose |
|---|---|
| `validate.ts`                    | Pre-flight: `validateUpgrade(proxy, IDRPv2)` AND `validateUpgrade(proxy, IDRPControllerv2)`. NO state-changing calls. Refuses to proceed past any failure. |
| `prepare-upgrade.ts`              | Deploy a new `IDRPv2` implementation contract on the target chain. Outputs the impl address. |
| `prepare-upgrade-controller.ts`   | Same for `IDRPControllerv2`. |
| `upgrade.ts`                      | Execute the IDRP v1 → v2 migration: `upgradeToAndCall(newImpl, initializeV2(safe, legacyHolders))`. |
| `upgrade-controller.ts`           | Same for the Controller. |

Pre-existing scripts at the top level that this folder reuses:
- `scripts/list-upgrader-holders.ts` — enumerates legacy `UPGRADER_ROLE`
  holders on the IDRP proxy via event replay. Produces
  `deployment/chain-{chainId}-legacy-upgrader-holders.json` which
  `upgrade.ts` reads.

---

## Per-chain checklist

For each affected testnet:

1. **Verify state.** Run
   `npx hardhat run scripts/check-contract-state.ts --network <name>`.
   Confirm `upgrader()` reverts on the IDRP or Controller you're about
   to migrate.

2. **Validate the upgrade is safe.** Run
   `npx hardhat run scripts/v1-to-v2/validate.ts --network <name>`. This
   calls `hre.upgrades.validateUpgrade` against the legacy contracts.
   Must pass before doing anything else.

3. **Enumerate legacy UPGRADER_ROLE holders (IDRP only).** Run
   `npx hardhat run scripts/list-upgrader-holders.ts --network <name>`.
   Produces `deployment/chain-{chainId}-legacy-upgrader-holders.json`.
   **Review the file** before continuing — confirm the holders match the
   expected set.

4. **Override `UPGRADE_DELAY` for testnet (if needed).** The legacy v2
   contracts have `UPGRADE_DELAY = 48 hours`. For testnet velocity you
   can temporarily edit `contracts/legacy/IDRPv2.sol` line 65 (and the
   equivalent on the Controller) to `5 minutes` **without committing**.
   Revert to 48 hours before mainnet ever uses these files.

5. **Deploy the new v2 implementation.** Run
   `npx hardhat run scripts/v1-to-v2/prepare-upgrade.ts --network <name>`
   for IDRP and/or `prepare-upgrade-controller.ts` for the Controller.
   Records the impl address in
   `deployment/chain-{chainId}.json` under `IDRPv2PreparedImpl` /
   `IDRPControllerv2PreparedImpl`.

6. **Execute the v1 → v2 migration.** Run
   `npx hardhat run scripts/v1-to-v2/upgrade.ts --network <name>` (and
   `upgrade-controller.ts`). This calls `upgradeToAndCall(newImpl,
   initializeV2(...))` atomically.

7. **Verify post-migration state.** Re-run
   `scripts/check-contract-state.ts`. `upgrader()` should now return
   the configured Safe/admin address. `UPGRADER_ROLE` should be
   revoked from every listed legacy holder.

8. **Record in UPGRADE_HISTORY.md.** Append a row under the chain
   heading with the date, the tx hash, and the note "v1 → v2 testnet
   migration via scripts/v1-to-v2/".

After this, the chain is ready for the v2 → v3 flow via the normal
top-level `scripts/`.

---

## Things this folder deliberately does NOT do

- **Does not run on mainnet.** Mainnet is already at v2. If you run
  these scripts against a mainnet RPC, the `validate` step will detect
  that `upgrader()` is already populated and abort.
- **Does not handle the v2 → v3 step.** That's the existing top-level
  `scripts/`.
- **Does not skip `validateUpgrade`.** No `unsafeSkipStorageCheck`,
  ever. If the OZ plugin refuses, do not work around it — investigate.
- **Does not touch storage directly.** All migrations go through
  `upgradeToAndCall` so the impl swap and initializer call are atomic.

---

## Related docs

- [`docs/design/v3-rollout-plan.md`](../../docs/design/v3-rollout-plan.md)
  — the broader v3 migration plan
- [`docs/design/path-a-drop-accesscontrol.md`](../../docs/design/path-a-drop-accesscontrol.md)
  — why the v3 IDRP can't do v1 → v2 itself
- [`contracts/legacy/IDRPv2.sol`](../../contracts/legacy/IDRPv2.sol)
  — the v2 implementation source these scripts deploy
- [`docs/upgrade/UPGRADE.md`](../../docs/upgrade/UPGRADE.md)
  — legacy operational playbook (predates v3; some rows now obsolete)

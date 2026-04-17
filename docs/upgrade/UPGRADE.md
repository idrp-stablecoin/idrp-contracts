# IDRP Upgrade Flow — Per-Chain Playbook

Operational guide for upgrading the `IDRP` and `IDRPController` proxies on each deployed chain after the April 2026 security-audit remediation.

Both contracts now enforce a **48-hour timelock** with explicit `schedule → wait → execute` steps. Multi-signature authorization is handled at the Safe wallet layer (the Safe address is `upgrader` on IDRP and `owner` on IDRPController). The contract-level rule is single-address; the Safe makes that address an N-of-M multisig transparently.

---

## Contents

1. [One-time precondition (per chain)](#1-one-time-precondition-per-chain)
2. [IDRP — v1 → v2 migration (one-time)](#2-idrp--v1--v2-migration-one-time)
3. [IDRP — v2+ upgrades (recurring, timelocked)](#3-idrp--v2-upgrades-recurring-timelocked)
4. [IDRPController — v2+ upgrades (recurring, timelocked)](#4-idrpcontroller--v2-upgrades-recurring-timelocked)
5. [Cancelling a scheduled upgrade](#5-cancelling-a-scheduled-upgrade)
6. [Reference — scripts, state, and events](#6-reference)

---

## 1. One-time precondition (per chain)

Before running any upgrade, verify:

- `deployment/chain-{chainId}.json` exists and contains the correct `IDRP` and `IDRPController` proxy addresses.
- The admin signer (`signers[1]`, configured via `IDRP_ADMIN_PRIVATE_KEY`) matches the authorized key on the Safe wallet for that chain.
- For the v1 → v2 migration only: the admin signer currently holds the legacy `UPGRADER_ROLE` on IDRP (this is the case on every chain where IDRP was originally deployed from `initialize()`).

> Chain IDs of record: Ethereum `1`, BSC `56`, Kaia `8217`, Polygon `137`, Tron (network name `tron`), and their testnets.

---

## 2. IDRP — v1 → v2 migration (one-time)

Run this once per chain to move from the legacy `UPGRADER_ROLE` model to the single-address `upgrader` + 48h timelock model. This migration is **instant** because it is still authorized by v1's `onlyRole(UPGRADER_ROLE)` check — the timelock only takes effect *after* migration.

### Step 1 — enumerate legacy `UPGRADER_ROLE` holders

```bash
npx hardhat run ./scripts/list-upgrader-holders.ts --network <network>
```

Replays `RoleGranted` / `RoleRevoked` events on the IDRP proxy and writes the current holder set to:

```
deployment/chain-{chainId}-legacy-upgrader-holders.json
```

Why this exists: IDRP uses plain `AccessControlUpgradeable` (not the Enumerable variant), so role holders cannot be listed on-chain.

**Review the file before proceeding.** On mainnet this is typically a single address (the initial `superAdmin`). On testnets it may include additional wallets granted manually during development.

### Step 2 — execute the migration

```bash
npx hardhat run ./scripts/upgrade.ts --network <network>
```

The script auto-detects a v1 proxy (`upgrader()` returns `address(0)`) and runs:

```
upgradeToAndCall(newImpl, initializeV2(_upgrader, legacyHolders))
```

atomically. On completion:

- `upgrader()` returns the admin address (post-migration you can rotate to Safe via `setUpgrader`).
- Every address in the legacy-holders list has had `UPGRADER_ROLE` revoked, so a future reintroduction of that role hash will not silently restore authority.
- `scheduledImplementation` and `upgradeScheduledAt` are both zero — clean state, no pending upgrade.

### Step 3 — rotate `upgrader` to the Safe (recommended)

If the admin key is not the Safe itself, rotate to the Safe as soon as migration completes:

```solidity
// Called from DEFAULT_ADMIN_ROLE (the Safe itself, via Safe tx)
idrp.setUpgrader(<safe-address>)
```

Emits `UpgraderUpdated(oldUpgrader, safeAddress)`. From this point, only Safe-signed transactions can schedule or execute upgrades on IDRP.

### Step 4 — record the migration

Append a row to [docs/upgrade-history/UPGRADE_HISTORY.md](../upgrade-history/UPGRADE_HISTORY.md) under the appropriate chain heading:

```
| <date> | [See](<explorer-tx-url>) | Security audit C-1: migrate UPGRADER_ROLE → single upgrader + 48h timelock | - |
```

---

## 3. IDRP — v2+ upgrades (recurring, timelocked)

All upgrades after the v1 → v2 migration follow this three-step flow.

### Step 1 — schedule the upgrade

```bash
npx hardhat run ./scripts/schedule-upgrade.ts --network <network>
```

This script:

1. Deploys the new IDRP implementation.
2. Calls `IDRP.scheduleUpgrade(newImpl)` (must be signed by `upgrader()`).
3. Persists `IDRPScheduledImpl`, `IDRPScheduledAt`, `IDRPExecutableAfter` into `deployment/chain-{chainId}.json`.
4. Emits `UpgradeScheduled(newImplementation, executableAfter)` — indexable for the OJK audit trail.

If an upgrade is already pending, the script aborts with the remaining time and the cancel instructions.

### Step 2 — wait 48h

No action required. During this window:

- Monitor `UpgradeScheduled` events and alerts for the proxy.
- Review the new implementation one more time against the audit and any outstanding reports.
- If anything looks wrong, run the cancel flow (see section 5).

### Step 3 — execute the upgrade

```bash
npx hardhat run ./scripts/upgrade.ts --network <network>
```

The script:

1. Detects that the proxy is already on v2+ (`upgrader()` is non-zero).
2. Reads `scheduledImplementation` from on-chain (source of truth).
3. Verifies `block.timestamp >= upgradeScheduledAt + 48h`; if not, prints remaining time and exits.
4. Calls `upgradeToAndCall(scheduledImpl, "0x")` — which triggers `_authorizeUpgrade`, enforcing both the upgrader check and the timelock check.
5. Clears `scheduledImplementation` and `upgradeScheduledAt` on-chain.
6. Cleans up the pending-upgrade entries from `deployment/chain-{chainId}.json`.

> The script calls `upgradeToAndCall` directly rather than `hre.upgrades.upgradeProxy`, because the latter redeploys the implementation by default and would produce a different address, failing the `"Upgrade not scheduled"` check.

### Step 4 — record the upgrade

Append a row to [docs/upgrade-history/UPGRADE_HISTORY.md](../upgrade-history/UPGRADE_HISTORY.md).

---

## 4. IDRPController — v2+ upgrades (recurring, timelocked)

Same flow shape as IDRP, with dedicated scripts.

### Step 1 — schedule

```bash
npx hardhat run ./scripts/schedule-upgrade-controller.ts --network <network>
```

Emits `UpgradeScheduled(newImplementation, executableAfter)`.

### Step 2 — wait 48h

### Step 3 — execute

```bash
npx hardhat run ./scripts/upgrade-controller.ts --network <network>
```

### Step 4 — record the upgrade

Append a row to [docs/upgrade-history/UPGRADE_HISTORY.md](../upgrade-history/UPGRADE_HISTORY.md).

IDRPController did not have a role-based upgrade model to migrate away from — `onlyOwner` has always been single-address (the Safe), so there is no v1 → v2 analog for this contract.

---

## 5. Cancelling a scheduled upgrade

If, during the 48h window, the pending implementation is found to be incorrect, cancel before it becomes executable.

### IDRP

```bash
npx hardhat run ./scripts/cancel-upgrade.ts --network <network>
```

### IDRPController

```bash
npx hardhat run ./scripts/cancel-upgrade-controller.ts --network <network>
```

Both scripts:

- Call `cancelUpgrade()` (gated by `upgrader` / `owner`).
- Emit `UpgradeCancelled(newImplementation, cancelledBy)`.
- Clear the pending-upgrade entries from `deployment/chain-{chainId}.json`.

After cancelling, the upgrade must be re-scheduled from step 1 of the recurring flow if you still want to ship a (potentially different) implementation.

---

## 6. Reference

### 6.1 Scripts

| Script | Contract | Purpose |
|---|---|---|
| [`list-upgrader-holders.ts`](../../scripts/list-upgrader-holders.ts) | IDRP | Event-replay discovery of legacy `UPGRADER_ROLE` holders. Writes JSON for use by `upgrade.ts`. |
| [`upgrade.ts`](../../scripts/upgrade.ts) | IDRP | Executes the upgrade. Auto-detects v1 → v2 migration vs v2+ execute-scheduled. |
| [`schedule-upgrade.ts`](../../scripts/schedule-upgrade.ts) | IDRP | v2+ only: deploys new impl + calls `scheduleUpgrade`. |
| [`cancel-upgrade.ts`](../../scripts/cancel-upgrade.ts) | IDRP | Cancels a pending scheduled upgrade. |
| [`schedule-upgrade-controller.ts`](../../scripts/schedule-upgrade-controller.ts) | IDRPController | Deploys new impl + calls `scheduleUpgrade`. |
| [`upgrade-controller.ts`](../../scripts/upgrade-controller.ts) | IDRPController | Executes a pre-scheduled upgrade after timelock. |
| [`cancel-upgrade-controller.ts`](../../scripts/cancel-upgrade-controller.ts) | IDRPController | Cancels a pending scheduled upgrade. |

### 6.2 On-chain state read cheatsheet

| What you want to know | Call |
|---|---|
| Current IDRP upgrader | `IDRP.upgrader()` |
| Pending IDRP upgrade target | `IDRP.scheduledImplementation()` |
| IDRP timelock start | `IDRP.upgradeScheduledAt()` |
| IDRP timelock duration | `IDRP.UPGRADE_DELAY()` (constant, `172800` seconds = 48h) |
| Current IDRPController owner | `IDRPController.owner()` |
| Pending IDRPController upgrade | `IDRPController.scheduledImplementation()` |
| IDRPController timelock start | `IDRPController.upgradeScheduledAt()` |

### 6.3 Events for OJK audit trail

Emitted by both IDRP and IDRPController with identical signatures so a single indexer handles both:

```solidity
event UpgradeScheduled(address indexed newImplementation, uint256 executableAfter);
event UpgradeCancelled(address indexed newImplementation, address indexed cancelledBy);
```

Plus IDRP-only, for upgrader rotation:

```solidity
event UpgraderUpdated(address indexed oldUpgrader, address indexed newUpgrader);
```

`Upgraded(address indexed implementation)` is emitted automatically by OZ's `ERC1967Upgrade` on successful execution.

### 6.4 Deployment file keys

`deployment/chain-{chainId}.json`:

| Key | Populated by | Cleared by |
|---|---|---|
| `IDRP` | initial deploy | never |
| `IDRPController` | initial deploy | never |
| `IDRPScheduledImpl` | `schedule-upgrade.ts` | `upgrade.ts` / `cancel-upgrade.ts` |
| `IDRPScheduledAt` | `schedule-upgrade.ts` | `upgrade.ts` / `cancel-upgrade.ts` |
| `IDRPExecutableAfter` | `schedule-upgrade.ts` | `upgrade.ts` / `cancel-upgrade.ts` |
| `IDRPControllerScheduledImpl` | `schedule-upgrade-controller.ts` | `upgrade-controller.ts` / `cancel-upgrade-controller.ts` |
| `IDRPControllerScheduledAt` | `schedule-upgrade-controller.ts` | `upgrade-controller.ts` / `cancel-upgrade-controller.ts` |
| `IDRPControllerExecutableAfter` | `schedule-upgrade-controller.ts` | `upgrade-controller.ts` / `cancel-upgrade-controller.ts` |

Separate file (not merged in) used only by the v1 → v2 migration:

| File | Produced by | Consumed by |
|---|---|---|
| `chain-{chainId}-legacy-upgrader-holders.json` | `list-upgrader-holders.ts` | `upgrade.ts` (v1 → v2 branch only) |

### 6.5 Safety checklist before any execute step

- [ ] Confirmed on-chain `scheduledImplementation` matches the address you intended to deploy.
- [ ] Confirmed `block.timestamp >= upgradeScheduledAt + UPGRADE_DELAY` (script enforces this, but verify in a block explorer first).
- [ ] Confirmed no in-flight TAP operations (for IDRPController) or pending burns (for IDRP) that rely on specific storage slots being at known offsets.
- [ ] Recorded the planned upgrade entry in [UPGRADE_HISTORY.md](../upgrade-history/UPGRADE_HISTORY.md) (can be updated post-execution with the real tx hash).
- [ ] OJK notification sent (for mainnet chains) per MoM 27 Feb 2026.

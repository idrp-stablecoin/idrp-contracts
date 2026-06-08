# `contracts/mocks/` — frozen version snapshots for upgrade tests

Test-only Solidity files that mirror the **storage layout** of previously
deployed IDRP / IDRPController implementations. They never ship anywhere —
they exist solely so the Hardhat test suite can deploy a "what was on
mainnet at version X" proxy, populate state, then attempt the upgrade to
the next implementation and verify the OZ Upgrades plugin accepts the
layout transition.

The OZ Upgrades plugin compares storage layouts (variable order, types,
sizes, namespaced slots) when planning an upgrade. If the new version
changes anything incompatible — re-ordering a slot, shrinking a type,
inserting a new variable mid-layout — the plugin refuses the upgrade.
Mocks let us hit that refusal in a unit test rather than in a mainnet tx.

---

## What's in here

| Mock file | Mirrors | Provenance |
|---|---|---|
| `IDRPV1Mock.sol`            | `deployment/logs/contracts/v1.IDRP.sol`           | Etherscan-verified v1 IDRP impl on Ethereum mainnet (latest pre-v2). |
| `IDRPV2Mock.sol`            | `deployment/logs/contracts/v2.IDRP.sol`           | Etherscan-verified v2 IDRP impl — what every prod proxy points to today. |
| `IDRPControllerV1Mock.sol`  | `deployment/logs/contracts/v1.IDRPController.sol` | Etherscan-verified v1 Controller impl (initial deploy). Inherits Ownable AND AccessControl. |
| `IDRPControllerV2Mock.sol`  | `deployment/logs/contracts/v2.IDRPController.sol` | Etherscan-verified v2 Controller impl — what every prod proxy points to today. Ownable removed, `upgrader` slot added. |

The mocks include `*Raw` helper functions (e.g. `setDepositoryWalletRaw`,
`mintRaw`, `setScheduledUpgradeRaw`) so tests can drive state into specific
slots without going through the real validation logic. Real business logic
is intentionally *not* mirrored — only what's required to:

- Reach the storage state we want to test against, and
- Pass the OZ Upgrades plugin's layout comparison.

---

## Rules for editing

1. **Storage layout is sacred.** Every `bytes32 public constant ROLE_FOO`,
   every sequential variable, every namespaced struct must be in the same
   order, type, and size as the snapshot in `deployment/logs/contracts/`.
   The OZ Upgrades plugin will catch most mistakes, but it can't catch
   logical confusion (e.g. typing a slot as `address` when prod has it as
   `bytes32`).
2. **If you change a mock, refresh the snapshot too.** The deployed sources
   in `deployment/logs/contracts/` are the source of truth. Updating a mock
   without updating its corresponding snapshot leaves future readers
   confused about which one is authoritative.
3. **Don't add post-version features.** A v1 mock must NOT have v2 storage.
   Easiest way to keep this honest is to write the mock by copy-pasting the
   snapshot, then deleting function bodies, not by editing the
   currently-deployed contract and rolling back.
4. **Don't add the next version's `initializeVN`.** If the v3 source has
   `initializeV3`, the v2 mock must NOT have it — that mismatch is the
   bug the migration test exists to catch.

---

## What the mocks are tested against

The corresponding tests live in `test/upgrade/` (to be added):

| Test | Path under test |
|---|---|
| `IDRP.v1-to-v3.test.ts`   | Deploy V1Mock → `upgradeProxy` to v3 final impl → assert storage preserved. |
| `IDRP.v2-to-v3.test.ts`   | Deploy V2Mock → call `initializeV2(...)` to set `upgrader` → `upgradeProxy` to v3 → call `initializeV3(...)` → assert. THIS IS THE PROD PATH. |
| `IDRP.v1-to-v2-to-v3.test.ts` | Full historical replay. |
| `Controller.v2-to-v3.test.ts` | Same shape for the Controller (the production path). |
| `Controller.v1-to-v2-to-v3.test.ts` | Full historical replay for the Controller. |

Plus a separate Pattern C test that runs against a **mainnet fork**
(no mocks involved) — that one is the strongest possible safety check
because it tests against the *actual* deployed bytecode, not an
approximation. See `test/upgrade/mainnet-fork.test.ts` (to be added).

---

## Related docs

- [`/deployment/logs/contracts/README.md`](../../deployment/logs/contracts/README.md)
  — explains where the snapshot source came from.
- [`/docs/design/upgrade-versions-timeline.md`](../../docs/design/upgrade-versions-timeline.md)
  — version definitions and migration matrix.
- [`/docs/design/no-defaultadmin-leftbehind.md`](../../docs/design/no-defaultadmin-leftbehind.md)
  — the ACDAR + revoke-then-init ordering that the V3-DualHolder test pins.

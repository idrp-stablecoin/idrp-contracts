# Tron mainnet v2 → v3 — runbook

Hand this to whoever holds the upgrader key. Branch: **`tron-main`**. Its contracts are the
v3 release (`contracts/` identical to `69ac77c`), and its `tron-*` scripts are the gated ones
described below. Background and rationale: [`TRON-MAINNET-V3-README.md`](../../TRON-MAINNET-V3-README.md).

The whole sequence below was run on 2026-10-30 with these exact scripts: first on a local Tron
node holding a replica of the testnet env (same code and storage as the Nile sandbox), then on the
Nile testnet env itself, which is now on v3. Every receipt matched the energy and bandwidth the
scripts measured beforehand.

---

## 1. What happened before, and what is left over

| When (UTC) | What | Result |
|---|---|---|
| 2026-06-29 | Controller v3 deploy, OpenZeppelin 5 build | ran out of energy: **311.68 TRX burned**, nothing deployed |
| 2026-06-30 | OZ 5 builds deployed and scheduled on **both** proxies | can never work: Tron's proxies are OZ 4, so OZ 5 reads every variable from the wrong slot |
| 2026-09-01 | Controller `upgradeToAndCall(OZ 5 build, initializeV3)` | reverted, atomically, nothing changed |
| 2026-09-03 | Controller schedule cancelled | ✓ |
| 2026-09-03 | Controller deploy (OZ 4 build, an earlier branch) | ran out of energy: **264.88 TRX burned**, nothing deployed |

What it leaves on mainnet today (read it again on the day):

- **The token still has the June OZ 5 build scheduled, and the upgrader can execute it.**
  Executed, the token would read balances, admin and upgrader from empty storage. **The first
  transaction of the first session is its cancel.** The controller has nothing pending.
- Both proxies are on v2, behind stock OZ 4 UUPS proxies, with a 48 h `UPGRADE_DELAY`.

Why the OZ 4 path: v3 is built on OZ 4.9.6 so that no storage slot moves — the quorum role
holders keep their roles with **no re-grant**, and there is no service outage. The single
default admin uses `AccessControlDefaultAdminRulesUpgradeable`, which OZ 4.9.6 ships.

| | |
|---|---|
| Controller proxy | `TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX` |
| Token proxy | `TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r` |
| Upgrader (both) | `TQHZ6XmErRcTaBjoWnBwd55sKdoUDfuNn6` — a single key; every write below is `onlyUpgrader` |
| Legacy `DEFAULT_ADMIN_ROLE` holders | enumerate on the day (`tron-list-default-admin-holders.ts`); last read: exactly one, the upgrader |

---

## 2. Funding — measure it, then fund it

Tron burns everything a transaction consumed when it runs out of energy. The fee limit is a
cap, not a reservation: when it is higher than the balance, the balance is the cap. That is how
the two deploys above burned 576.56 TRX and deployed nothing.

**Every script is a dry run unless `EXECUTE=1`.** Before it sends anything it simulates the exact
transaction on the node, measures energy and bandwidth, reads the account and the chain's prices,
and refuses unless the account can cover **1.1×** the measured energy. It sets the fee limit to
**1.2×** the measured energy, so even a wrong estimate cannot cost more. The dry run prints all of
it: run every step without `EXECUTE=1` first and read the `funding` line.

Plan the money with:

```bash
ACCOUNT=TQHZ6XmErRcTaBjoWnBwd55sKdoUDfuNn6 npx hardhat run scripts/tron-funding-check.ts --network tron
```

Measured on mainnet, 2026-10-30 (100 sun per energy, 1,000 sun per byte):

| Session | Step | Energy | Bytes | TRX if burned |
|---|---|---|---|---|
| 1 | token `cancelUpgrade()` | 12,363 | 280 | 1.52 |
| 1 | deploy the controller implementation | 4,362,064 | 26,602 | 462.81 |
| 1 | controller `scheduleUpgrade` | 42,516 | 314 | 4.57 |
| 2 | controller `upgradeToAndCall(initializeV3)` | 88,718 * | 571 * | 9.44 |
| 2 | deploy the token implementation | 3,666,145 | 22,908 | 389.52 |
| 2 | token `scheduleUpgrade` | 42,578 | 314 | 4.57 |
| 3 | token `upgradeToAndCall(initializeV3)` | 82,406 * | 507 * | 8.75 |
| | **total** | **8,296,790** | **51,496** | **881.18** |

\* the receipts of the same two calls on the Nile testnet env (2026-10-30, identical on a local
node); mainnet can measure them only once the schedules mature, and the script does then.

- **Burn only:** hold **1,000 TRX** before session 1 and top up between sessions as the funding
  check says.
- **Renting energy:** rent for one session at a time, to the upgrader's **address** (never connect
  its wallet or key to a rental site), right before running it, and keep ≥ 50 TRX in the account
  for bandwidth: a 26,602-byte deploy cannot use rented or free bandwidth, it burns about 27 TRX.
- Contracts that are used heavily pay a dynamic-energy surcharge on Tron. Measured 2026-10-30:
  neither IDRP contract carries one. The dry run would include it if that changed.

---

## 3. What to run

Times the scripts print are UTC. Keep every output.

### Session 1 — checks, the cancel, the controller deploy and schedule

```bash
git checkout tron-main
git pull
git diff 69ac77c -- contracts/
npm ci
```

`git diff` must print nothing: the contracts are the rehearsed release. `npm ci` also patches
`@layerzerolabs/hardhat-tron` so Node 22 and later work (Node 20, 24 and 25 measured).

Read-only gates — nothing is sent:

```bash
npx hardhat run scripts/verify-deployed-source.ts --network tron
npx hardhat run scripts/verify-live-layout.ts --network tron
npx hardhat test test/upgrade/TronUpgradeRepeatability.ts test/upgrade/UupsBaseLayout.ts
npx hardhat run scripts/tron-list-default-admin-holders.ts --network tron
TARGET=controller SNAPSHOT=controller-before.json npx hardhat run scripts/tron-verify-v3.ts --network tron
TARGET=token SNAPSHOT=token-before.json npx hardhat run scripts/tron-verify-v3.ts --network tron
```

Expect `ALL TARGETS VERIFIED`, `LAYOUT VERIFIED AGAINST LIVE MAINNET` and `9 passing`. If any
fails, stop.

The cancel — dry run, then send:

```bash
TARGET=token npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
TARGET=token EXECUTE=1 npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
```

It must end with `✓ cleared`.

The controller implementation — dry run, then send:

```bash
npx hardhat run scripts/tron-deploy-controller-v3-impl.ts --network tron
EXECUTE=1 npx hardhat run scripts/tron-deploy-controller-v3-impl.ts --network tron
```

It refuses uncommitted contracts, compiles with tron-solc, checks the build's timelock constants,
and after the deploy proves the code on chain is the build. It records the exact compiler input
under `deployment/builds/728126428/` and the deploy in `deployment/tron/mainnet.json`. Commit
both.

**Verify it on Tronscan before it can go live:**

```bash
npx hardhat run scripts/tron-explorer-files.ts --network tron
```

It proves the recorded input reproduces the on-chain code, writes the single-file source to
`flattened/tron/`, and prints the form values. Submit the form at
`https://tronscan.org/#/contract/<implementation>/code`. If verification fails, do not schedule.

Then schedule it — dry run, then send:

```bash
IMPL=<controller implementation> npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron
IMPL=<controller implementation> EXECUTE=1 npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron
```

Before sending, it checks the implementation on chain: every timelock constant is 48 h, and
`initializeV3` is present with its initializer locked the OpenZeppelin 4 way (an OZ 5 build is
refused). It prints when the upgrade becomes executable.

### Session 2 — at least 48 h later: execute the controller, then deploy and schedule the token

Enumerate the legacy admins again and pass exactly that list. `initializeV3` revokes only what it
is given; a holder left out keeps `DEFAULT_ADMIN_ROLE`.

```bash
npx hardhat run scripts/tron-list-default-admin-holders.ts --network tron
```

`CTRL_V3_ADMIN` and `CTRL_V3_UPGRADER` are required; nothing defaults to the signer. To keep
today's single key, pass the upgrader for both. To move to a multisig, pass its address. Then:

```bash
CTRL_V3_ADMIN=<admin> CTRL_V3_UPGRADER=<upgrader> CTRL_V3_LEGACY_DAR_HOLDERS=<list> npx hardhat run scripts/tron-execute-controller-upgrade.ts --network tron
CTRL_V3_ADMIN=<admin> CTRL_V3_UPGRADER=<upgrader> CTRL_V3_LEGACY_DAR_HOLDERS=<list> EXECUTE=1 npx hardhat run scripts/tron-execute-controller-upgrade.ts --network tron
TARGET=controller BASELINE=controller-before.json npx hardhat run scripts/tron-verify-v3.ts --network tron
```

The execute is **one atomic `upgradeToAndCall(impl, initializeV3(...))`**. Never split it into
`upgradeTo` plus a separate initializer: the atomic call is what makes a failure harmless, and
splitting it is what deadlocked a Nile controller. The dry run simulates the exact call first.
Afterwards the script checks `defaultAdmin()`, the upgrader, the revocations, the quorum roles
(no re-grant), both `idrp.tron.uups.*` slots (must be `0x0`) and that the upgrade gate still
passes. The verify run must end with `✓ nothing changed that the upgrade must not change`.

Watch the controller live before the token goes on: the platform's operations keep working
against the v2 token (rehearsed), and the one change is that a reused or empty operation
identifier is refused.

Then the token implementation, the same way as the controller's:

```bash
npx hardhat run scripts/tron-deploy-idrp-v3-impl.ts --network tron
EXECUTE=1 npx hardhat run scripts/tron-deploy-idrp-v3-impl.ts --network tron
npx hardhat run scripts/tron-explorer-files.ts --network tron
IMPL=<token implementation> npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron
IMPL=<token implementation> EXECUTE=1 npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron
```

Verify it on Tronscan between the deploy and the schedule.

### Session 3 — at least 48 h later: execute the token

Snapshot again right before (the supply moves with every mint and burn), and name every frozen
account so their flags are compared:

```bash
TARGET=token SNAPSHOT=token-before-execute.json CHECK_ACCOUNTS=<frozen T…,…> npx hardhat run scripts/tron-verify-v3.ts --network tron
IDRP_V3_ADMIN=<admin> IDRP_V3_UPGRADER=<upgrader> npx hardhat run scripts/tron-execute-idrp-upgrade.ts --network tron
IDRP_V3_ADMIN=<admin> IDRP_V3_UPGRADER=<upgrader> EXECUTE=1 npx hardhat run scripts/tron-execute-idrp-upgrade.ts --network tron
TARGET=token BASELINE=token-before-execute.json CHECK_ACCOUNTS=<frozen T…,…> npx hardhat run scripts/tron-verify-v3.ts --network tron
```

`IDRP_V3_CONTROLLER` defaults to the controller proxy. Supply, balances, frozen flags and
`DOMAIN_SEPARATOR` (`permit()`) must be unchanged.

### If something reverts

A revert during `upgradeToAndCall` is **safe**: the implementation swap rolls back and the proxy
is untouched. Capture the reason and stop. Do not retry with a split call. A dry run that refuses
for funding sent nothing; fund the shortfall it prints and run it again.

---

## 4. Reproducing the evidence

```bash
docker run -d --name idrp-tre -p 9090:9090 tronbox/tre
npx hardhat run scripts/tvm/make-fixtures.ts
npx hardhat run scripts/tre-suite.ts --network tre
npx hardhat run scripts/tre-mainnet-rehearsal.ts --network tre
npx hardhat run scripts/tre-authority-transfer.ts --network tre
```

`make-fixtures` must leave `git status` clean. Expect token 25/25, the controller rehearsal
green (roles 4/4, still upgradeable), and 36/36. The testnet-env rehearsal — a 1:1 replica of
the Nile sandbox upgraded with the scripts above — lives on `tron-testnet`
(`scripts/tre-sandbox-ops.ts`).

## Rules

1. **Atomic `upgradeToAndCall` only.** Never split the upgrade from its initializer.
2. **Data-less upgrades use `upgradeTo`.** OZ 4's `upgradeToAndCall` forces a delegatecall even
   with empty calldata.
3. **Verify against deployed bytecode and live storage, never against repo source.**
4. **No UUPS whose proxy check depends on storage.** That is the deadlock class.
5. **Fund before you send.** A dry run first, every time.
6. **Verify each implementation on Tronscan while the timelock runs**, before executing it.

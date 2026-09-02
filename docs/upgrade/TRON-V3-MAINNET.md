# Tron mainnet v2 → v3 — deploy and schedule

Hand this to whoever holds the upgrader key. Branch: **`mainnet-ready-impl`**, merged
into **`tron`**. Background and rationale: [`TRON-MAINNET-V3-README.md`](../../TRON-MAINNET-V3-README.md).

Everything below has been rehearsed on a local TVM from mainnet's real starting state,
against the deployed v2 sources. **Nothing here has been run on mainnet.**

---

## The facts this depends on

| | value |
|---|---|
| Controller proxy | `TSQFFuzLK7f3EVGenQyQpXrpoFuDsXEvbX` |
| Token proxy | `TQn7gmXFj6oPFkFytQkpK1utAx9V9Ah97r` |
| Current `upgrader()` on both | `TQHZ6XmErRcTaBjoWnBwd55sKdoUDfuNn6` (`0x9d0a05af…78ba`) |
| Legacy `DEFAULT_ADMIN_ROLE` holders | **exactly one:** `0x9d0a05af0f1fcf33ffa4ec74d3bdbf63e0ff78ba` |
| `UPGRADE_DELAY` | 48 h on both, unchanged |
| Pending (poisoned) Controller schedule | `41ecf9e211dfaf7ab5936ecb5601934aa38c8f96aa`, executable since 2026-07-02 |
| Pending (poisoned) Token schedule | `0x66acb0ad5ce62b1ae389ed890c663b528d2c3c46` |

**The signer must be the upgrader key.** Every write below is `onlyUpgrader`. If it is
ever moved to a multisig, propose the same calls through TronLink/TronScan instead of
running the scripts.

---

## Step 0 — build and self-check (no chain writes)

```bash
git checkout mainnet-ready-impl
npm ci
npx hardhat compile --network tron          # tron-solc 0.8.22, artifacts-tron/

npx hardhat run scripts/verify-deployed-source.ts --network tron   # read-only
npx hardhat run scripts/verify-live-layout.ts     --network tron   # read-only
npx hardhat test test/upgrade/TronUpgradeRepeatability.ts test/upgrade/UupsBaseLayout.ts
```

Expect `ALL TARGETS VERIFIED`, `LAYOUT VERIFIED AGAINST LIVE MAINNET`, and `8 passing`.
(Name the two files — `hardhat test` does not accept a directory or a glob, and
`test/upgrade/` also holds a mainnet-fork test that self-skips without
`MAINNET_FORK_RPC_URL`.)
If any of those fail, stop — do not deploy.

Re-confirm the admin list on the day rather than trusting the table above, and capture a
before-state for both proxies:

```bash
npx hardhat run scripts/tron-list-default-admin-holders.ts --network tron

TARGET=controller npx hardhat run scripts/tron-verify-v3.ts --network tron
TARGET=token      npx hardhat run scripts/tron-verify-v3.ts --network tron
```

Keep that output. It is the baseline you compare against afterwards.

### Funding — check before you begin

Every script signs with `IDRP_DEPLOYER_PRIVATE_KEY_TRON`, and `schedule` / `execute` /
`cancel` all require that key to be the upgrader. So the **upgrader account** pays for
everything, including the two implementation deploys.

Measured from the actual v2 deploy transactions, scaled by bytecode size, at the current
100 SUN/energy:

| | energy | cost |
|---|---|---|
| Controller v3 deploy | ~4.28 M | **~430 TRX** |
| Token v3 deploy | ~3.32 M | **~330 TRX** |
| 2 cancels + 2 schedules + 2 executes | — | ~100–200 TRX |
| **total** | | **~900–1000 TRX** |

*(For reference the real v2 deploys cost 324 TRX / 3,057,781 energy for the Controller and
362 TRX / 3,406,419 energy for the Token.)*

The account has **no staked energy**, so all of that is a TRX burn. Check the balance
before starting:

```bash
curl -s -X POST https://api.trongrid.io/wallet/getaccount \
  -H 'Content-Type: application/json' \
  -d '{"address":"TQHZ6XmErRcTaBjoWnBwd55sKdoUDfuNn6","visible":true}' | grep -o '"balance":[0-9]*'
```

Divide by 1,000,000 for TRX. **Fund it to ~1,500 TRX before step 2** — a deploy that runs
out mid-flight wastes the fee and the session. `feeLimit` is clamped to the chain maximum
of 1000 TRX per transaction, so no single call can overspend, but the balance must be
there.

---

## Step 1 — clear the two poisoned schedules

Both proxies still have an OZ 5 implementation scheduled from June, executable since
July. Neither can succeed. The Token's is actively dangerous: the live OZ 4
implementation still exposes `upgradeTo`, which **would** succeed and brick the contract
holding every user balance.

Dry run first — this prints what it would send and exits:

```bash
TARGET=controller npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
TARGET=token      npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
```

Then broadcast:

```bash
TARGET=controller EXECUTE=1 npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
TARGET=token      EXECUTE=1 npx hardhat run scripts/tron-cancel-upgrade.ts --network tron
```

Both must end with `scheduledImplementation: …0000  ✓ cleared`.

> **On "scheduling just replaces the old one".** At the contract level that is true — the
> deployed v2 `scheduleUpgrade` overwrites `scheduledImplementation` and resets
> `upgradeScheduledAt` with no pending-check, so scheduling the good implementation would
> also neutralise the poisoned one and restart the 48 h clock. Cancelling first is still
> preferred: it is one explicit, auditable action, and it leaves
> `scheduledImplementation == 0` as a checkpoint anyone can verify before something new is
> scheduled. If you do want to skip the cancel, the schedule scripts accept
> `REPLACE_PENDING=1`.

---

## Step 2 — Controller: deploy, schedule, wait, execute

```bash
# deploy the implementation (real TRX)
npx hardhat run scripts/tron-deploy-controller-v3-impl.ts --network tron
# -> prints Address (hex). Call it $CTRL_IMPL.

# schedule
IMPL=$CTRL_IMPL npx hardhat run scripts/tron-schedule-controller-upgrade.ts --network tron
```

The script refuses if `UPGRADE_DELAY != 48h`, if a schedule is already pending, or if the
signer is not `upgrader()`. It prints the exact `executable after` timestamp.

**Wait the full 48 hours.** Then:

```bash
npx hardhat run scripts/tron-execute-controller-upgrade.ts --network tron
```

That calls `upgradeToAndCall(scheduledImpl, initializeV3(admin, upgrader, legacyHolders))`
in **one atomic transaction**. Never split it into `upgradeTo` plus a separate initializer
— splitting removes the rollback that makes a failure harmless, and is what bricked the
Nile Controller.

`_legacyDefaultAdminHolders` must be exactly the array Step 0 printed.

### Verify before declaring done

```bash
TARGET=controller npx hardhat run scripts/tron-verify-v3.ts --network tron
```

(`check-tron-roles.ts` does **not** cover this — it reads a deployment JSON and only
checks the Token's MINTER/PAUSER/FREEZER/UPGRADER roles.)

Pre-upgrade baseline captured 2026-09-03:

```
implementation            0x1f49fcf152c62e49f49fb225c630c94ffd56dd84  (TCpean…qpsX)
upgrader()                0x9d0a05af0f1fcf33ffa4ec74d3bdbf63e0ff78ba
idrpToken()               0xa270dfc7cb955b0fc54beb8b570fd6b1ee4ea7fc
defaultAdmin()            reverts — ACDAR, only exists in v3
scheduledImplementation() 0xecf9e211dfaf7ab5936ecb5601934aa38c8f96aa   <- poisoned
OFFICER / MANAGER / DIRECTOR / COMMISSIONER                            4/4 ✓
idrp.tron.uups.__self / __proxy                                        0x0 / 0x0 ✓
upgrade path (simulated)  reverts "Upgrade not scheduled"              healthy ✓
```

After the upgrade expect: implementation changed, `defaultAdmin()` now answering,
`scheduledImplementation()` back to `0x0`, quorum roles still **4/4 with no re-grant**,
both TronUUPS slots still `0x0`, and the simulated upgrade path still reaching the
timelock check.

Three of those matter most:

- **4/4 roles** is the whole reason for choosing the OZ 4 path — no role re-grant, no
  service outage.
- **Both TronUUPS slots `0x0`.** If either is ever non-zero, upgrades stop working
  permanently. The script exits non-zero if it sees that.
- **The simulated upgrade path.** You cannot prove a mainnet proxy is still upgradeable by
  upgrading it again, so the script simulates `upgradeTo` and reads *where* it reverts.
  `upgradeTo` runs the UUPS proxy gate before `_authorizeUpgrade`, so the reason tells you
  which stage was reached:

  | revert reason | meaning |
  |---|---|
  | `"Upgrade not scheduled"` / `"Timelock not expired"` | gate PASSED, reached the timelock logic — **healthy** |
  | `"Function must be called through active proxy"` / `"…delegatecall"` / `0xbeb6ee1f` | gate FAILED — **frozen, no upgrade can ever land** |

  Nothing is broadcast.

---

## Step 3 — Token

**Do not start until the Controller has been live and observed.** The Token holds every
user balance, so it goes second even though the evidence is equally strong.

```bash
npx hardhat run scripts/tron-deploy-idrp-v3-impl.ts --network tron
IMPL=$TOKEN_IMPL npx hardhat run scripts/tron-schedule-idrp-upgrade.ts --network tron
# wait 48 h
npx hardhat run scripts/tron-execute-idrp-upgrade.ts --network tron
TARGET=token npx hardhat run scripts/tron-verify-v3.ts --network tron
```

Pre-upgrade baseline captured 2026-09-03:

```
implementation            0xc1e38647c0529c2a3c0212e2c949bb0cf8f9a3e8  (TTePym…bUvc)
upgrader()                0x9d0a05af0f1fcf33ffa4ec74d3bdbf63e0ff78ba
admin() / controller()    revert — only exist in v3
sanctionsList()           0xe7eb27194eda053e44be061d6c4f0be8b31cb76f
scheduledImplementation() 0x66acb0ad5ce62b1ae389ed890c663b528d2c3c46   <- poisoned
idrp.tron.uups.__self / __proxy                                        0x0 / 0x0 ✓
```

Then confirm `DOMAIN_SEPARATOR` is **unchanged** from its pre-upgrade value. It derives
from EIP712's `_name`/`_version` at slots 301-304, so if the 100-slot
`LegacyAccessControlSlots` placeholder were off by even one slot it would change and
`permit()` would break silently. The rehearsal shows it does not change.

---

## Reproducing the evidence

```bash
docker run -d --name idrp-tre -p 9090:9090 tronbox/tre     # local TVM, free
npx hardhat compile --network tron
npx hardhat run scripts/tvm/make-fixtures.ts               # generated, drift-checked
npx hardhat run scripts/tre-mainnet-rehearsal.ts --network tre     # Controller
npx hardhat run scripts/tre-suite.ts             --network tre     # Token + TronUUPS
npx hardhat run scripts/tre-tronuups-suite.ts    --network tre     # why not TronUUPS
```

Expect Controller green (roles 4/4), Token **25/25**, TronUUPS suite **10/10**.

The fixtures exist because both v2 and v3 hard-code `UPGRADE_DELAY = 48 hours`; the
generator copies each source changing **only** that constant, the relative imports, and
the contract declaration name, and fails if the transform is not exactly reversible.

---

## Rules

1. **Atomic `upgradeToAndCall` only.** Never split the upgrade from its initializer.
2. **Data-less upgrades use `upgradeTo`.** OZ 4's `upgradeToAndCall` forces a delegatecall
   even with empty calldata and reverts `"Address: low-level delegate call failed"`.
3. **Verify against deployed bytecode and live storage, never against repo source.**
4. **No UUPS whose proxy check depends on storage.** That is the deadlock class.
5. **Rehearse on local TVM first.** It is free, and it starts from mainnet's real state.

## If something reverts

A revert during `upgradeToAndCall` is **safe** — the implementation swap is rolled back
and the proxy is untouched. Capture the revert reason and stop; do not retry with a split
call.

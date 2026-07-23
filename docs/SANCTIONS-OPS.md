# Sanctions ops — add / remove / check a wallet, per VM

How to sanction (or de-sanction) a single wallet on every VM IDRP runs on, and
how that flows into the stable-dashboard admin badge. For the BULK
OpenSanctions pipeline see `scripts/sanctions/{fetch-opensanctions,seed-from-opensanctions}.ts`
— this doc is the surgical, per-wallet path.

> ⛔ **Rule 0**: `add`/`remove` on any **mainnet** changes real on-chain state.
> The scripts hard-require `ALLOW_MAINNET=1` there — set it only after explicit
> sign-off. Testnets (Base Sepolia, Nile, Solana devnet) are fair game.

## Who owns which list (verified live 2026-07-22)

| Network | List | Owner / authority | Writable by us? |
|---|---|---|---|
| Ethereum / Polygon / BSC | Chainalysis oracle `0x40C57923…ADDaC8fb` | Chainalysis | **No** — managed upstream |
| Kaia (8217) | our clone `0x12aC41B1…08F96` | deployer | Yes (mainnet — Rule 0) |
| Kairos (1001) | `sanctionsList() = 0x0` | — | Not wired |
| Base Sepolia (84532) | our clone `0x4DC902bb…0023` | deployer | Yes (testnet) |
| Tron mainnet | `TX7Uo51XMmhJvbke6HzWE9hXRxvzWfpZUM` | deployer EOA `TQHZ6XmE…uNn6` | Yes (mainnet — Rule 0) |
| Tron Nile | `TBCVynr5bAZWpiDt1WDCH8dWnkDUTdJqPp` | same | Yes (testnet) |
| Solana devnet (spike) | ABL block list `EyPfxixm…3egc` | spike admin `F8zk…fQoa` | Yes (devnet) |
| Solana mainnet | — | — | No deployment yet |

The scripts never trust this table for the EVM/Tron list address: they read
`sanctionsList()` off the IDRP token at runtime (deployment JSONs drift;
on-chain is the source of truth). The table is orientation only.

## EVM + Tron — `scripts/sanctions/manage-list.ts`

One hardhat script for both VMs (Tron networks ride `@layerzerolabs/hardhat-tron`,
so `--network nile|tron` behaves like any EVM network; `T…` base58 wallet args
are converted automatically and output shows both forms).

```bash
# status (read-only, any network)
WALLET=0xabc… npx hardhat run scripts/sanctions/manage-list.ts --network baseSepolia
WALLET=TXYZ…  npx hardhat run scripts/sanctions/manage-list.ts --network nile

# add / remove — dry-run first (default), then APPLY=1 to send
WALLET=0xabc… ACTION=add    APPLY=1 npx hardhat run scripts/sanctions/manage-list.ts --network baseSepolia
WALLET=TXYZ…  ACTION=remove APPLY=1 npx hardhat run scripts/sanctions/manage-list.ts --network nile

# mainnet (kaia / tron) — additionally requires the Rule-0 ack
WALLET=… ACTION=add APPLY=1 ALLOW_MAINNET=1 npx hardhat run scripts/sanctions/manage-list.ts --network kaia
```

Behavior and guards:

- **Discovery**: IDRP address from `deployment/chain-<id>.json` (EVM) or
  `deployment/tron/{mainnet,nile}.json`, then `sanctionsList()` on the token.
  Overrides: `IDRP_ADDRESS=…`, `SANCTIONS_LIST_ADDRESS=…`.
- **Chainalysis refusal**: on ETH/Polygon/BSC the pointer is the real
  Chainalysis oracle — the script refuses writes there (we're not the owner).
- **Owner match**: the signer must be the list's `owner()` (picked from the
  configured hardhat accounts) or the script refuses before sending.
- **Dry-run default**: without `APPLY=1` it prints the plan and exits.
- `WALLET` takes a comma-separated list for small batches.

Known env quirk: the shared Alchemy key currently has **Base Sepolia disabled**
("BASE_SEPOLIA is not enabled for this app") — enable it in the Alchemy
dashboard or point `hardhat.config.ts` at another RPC before running there.

## Solana — two scripts, know which list you're touching

Two devnet instances exist (see `../idrp-contracts-solana/docs/DEPLOYMENTS.md`):
the **legacy** instance (what the general ops tooling's IDL points at — can
never adopt Token ACL) and the **ACL spike** instance (mint `593Fn…`), whose
block list `EyPfxixm…` is what the **dashboard badge reads**.

In `../idrp-contracts-solana`:

```bash
# Spike list (the dashboard's badge list) — add | remove | status
npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
  scripts/acl-list-spike.ts add    <owner-pubkey>
npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
  scripts/acl-list-spike.ts remove <owner-pubkey>
npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
  scripts/acl-list-spike.ts status <owner-pubkey>
```

Signer = the spike admin keypair (`~/.config/solana/id.json`, override
`SOLANA_KEYPAIR`). The script derives the list from (admin, spike mint) and
**aborts unless it equals the spike list**, so it can't write anywhere else.
It touches only the ABL gate (list membership = what the badge shows); it does
NOT freeze-sweep token accounts — for the full blocklist+sweep flow on a wired
instance use `scripts/acl-list.ts` (which follows the locally built IDL's
controller; on `main` that's the legacy instance).

"Sanctioned" on Solana = the ABL `wallet_entry` PDA
`[b"wallet_entry", list_config, wallet]` exists under the gate program
`GATEzz…iULz` **and is owned by it** (the dashboard also checks ownership, so
lamport-dusting the PDA can't fake a badge).

## How this reaches the dashboard badge

The stable-dashboard admin transaction list/detail (branch
`feat/sanctioned-wallet-flag`) checks per row:

- **EVM/Tron**: `sanctionsList()` on the IDRP token (AppSettings
  `idrpAddress{chainId}`), then `isSanctioned(address)` — zero config.
- **Solana**: `wallet_entry` existence on the list named by AppSettings
  `ablListConfigSolanaDevnet` / `…Mainnet` (devnet is seeded with the spike
  list). Unset ⇒ no badge.

Results cache server-side for **5 minutes** (30 s for errors) — after an
add/remove, wait out the cache or restart the dev server to see the badge flip.

## List DATA provenance

Adding a wallet by hand marks it sanctioned **for testing/emergencies**. The
OFAC-aligned content comes from the OpenSanctions pipeline
(`fetch-opensanctions.ts` → `seed-from-opensanctions.ts` for EVM/Tron; the
Solana ABL writer job is a planned idrp-api follow-up, not built yet).

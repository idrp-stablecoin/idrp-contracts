/**
 * Manage the SanctionsList for ONE wallet (or a few) — the manual add/remove/
 * status tool. The bulk OpenSanctions pipeline lives in
 * `seed-from-opensanctions.ts`; this is the surgical counterpart (test a
 * dashboard badge, emergency-list a wallet, verify a report).
 *
 * Works on BOTH VMs from the same script: EVM networks and the Tron networks
 * (`nile` / `tron` / `shasta` go through @layerzerolabs/hardhat-tron, so the
 * ethers surface is identical; Tron `T…` base58 wallet args are converted).
 *
 * The list address is DISCOVERED from the IDRP token's `sanctionsList()`
 * pointer (deployment JSONs drift — on-chain is the source of truth). On
 * ETH / Polygon / BSC that pointer is the real Chainalysis oracle, which we do
 * NOT own — writes there are impossible by design and the script says so.
 *
 * USAGE (dry-run by default, like seed-from-opensanctions.ts):
 *
 *   # status (read-only, always allowed)
 *   WALLET=0xabc…                npx hardhat run scripts/sanctions/manage-list.ts --network baseSepolia
 *   WALLET=TXYZ…  ACTION=status  npx hardhat run scripts/sanctions/manage-list.ts --network nile
 *
 *   # add / remove — shows the plan, then requires APPLY=1 to send
 *   WALLET=0xabc… ACTION=add    APPLY=1 npx hardhat run scripts/sanctions/manage-list.ts --network baseSepolia
 *   WALLET=TXYZ…  ACTION=remove APPLY=1 npx hardhat run scripts/sanctions/manage-list.ts --network nile
 *
 *   # mainnets (kaia / tron / …) additionally require ALLOW_MAINNET=1 (Rule 0:
 *   # real on-chain state — get explicit sign-off before running)
 *   WALLET=… ACTION=add APPLY=1 ALLOW_MAINNET=1 npx hardhat run … --network kaia
 *
 * Env:
 *   WALLET                  comma-separated wallet address(es), 0x… or T…
 *   ACTION                  status (default) | add | remove
 *   APPLY=1                 actually send the tx (otherwise dry-run)
 *   ALLOW_MAINNET=1         extra ack required on mainnet networks
 *   IDRP_ADDRESS            override the token address (skips deployment JSON)
 *   SANCTIONS_LIST_ADDRESS  override the list address (skips discovery)
 */

import fs from "fs";
import path from "path";
import hre from "hardhat";
import { ethers } from "hardhat";
import {
  Contract,
  decodeBase58,
  encodeBase58,
  getBytes,
  hexlify,
  sha256,
  toBeHex,
  ZeroAddress,
} from "ethers";

const IDRP_ABI = ["function sanctionsList() view returns (address)"];
const LIST_ABI = [
  "function isSanctioned(address addr) view returns (bool)",
  "function owner() view returns (address)",
  "function name() view returns (string)",
  "function addToSanctionsList(address[] newSanctions)",
  "function removeFromSanctionsList(address[] removeSanctions)",
];

/** Networks that hold real value — require ALLOW_MAINNET=1 (Rule 0). */
const MAINNET_NETWORKS = new Set(["mainnet", "polygon", "bsc", "kaia", "tron"]);
const TRON_NETWORKS = new Set(["tron", "nile", "shasta"]);

/** The real Chainalysis oracle (same address on ETH/Polygon/BSC). Not ours. */
const CHAINALYSIS_ORACLE = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";

// ── Tron base58check <-> EVM hex ────────────────────────────────────────────

/** `T…` base58check → `0x…` 20-byte hex. Throws on bad checksum/shape. */
function tronBase58ToHex(b58: string): string {
  let bytes = getBytes(toBeHex(decodeBase58(b58), 25));
  if (bytes.length !== 25 || bytes[0] !== 0x41) {
    throw new Error(`Not a Tron base58check address: ${b58}`);
  }
  const payload = bytes.slice(0, 21);
  const check = bytes.slice(21);
  const expected = getBytes(sha256(sha256(payload))).slice(0, 4);
  if (hexlify(check) !== hexlify(expected)) {
    throw new Error(`Bad base58check checksum: ${b58}`);
  }
  return hexlify(payload.slice(1));
}

/** `0x…` 20-byte hex → `T…` base58check. */
function hexToTronBase58(hex: string): string {
  const payload = getBytes("0x41" + hex.replace(/^0x/, ""));
  const check = getBytes(sha256(sha256(payload))).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(check, 21);
  return encodeBase58(full);
}

// ── Address resolution ──────────────────────────────────────────────────────

function resolveIdrpAddress(networkName: string, isTron: boolean): string {
  const override = process.env.IDRP_ADDRESS;
  if (override) return isTron && override.startsWith("T")
    ? tronBase58ToHex(override)
    : override;

  const file = isTron
    ? path.join(__dirname, "../../deployment/tron", `${networkName === "tron" ? "mainnet" : networkName}.json`)
    : path.join(__dirname, "../../deployment", `chain-${hre.network.config.chainId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment record ${file} — set IDRP_ADDRESS=… explicitly.`,
    );
  }
  const idrp = (JSON.parse(fs.readFileSync(file, "utf-8")) as { IDRP?: string })
    .IDRP;
  if (!idrp) throw new Error(`No "IDRP" key in ${file}`);
  return idrp.startsWith("T") ? tronBase58ToHex(idrp) : idrp;
}

function parseWallets(isTron: boolean): string[] {
  const raw = process.env.WALLET;
  if (!raw) {
    throw new Error(
      "Set WALLET=<address>[,<address>…] (0x… hex, or T… base58 on Tron networks).",
    );
  }
  return raw.split(",").map((w) => {
    const t = w.trim();
    if (t.startsWith("T")) {
      if (!isTron) throw new Error(`Base58 address on a non-Tron network: ${t}`);
      return tronBase58ToHex(t);
    }
    return t;
  });
}

function fmtAddr(hex: string, isTron: boolean): string {
  return isTron ? `${hexToTronBase58(hex)} (${hex})` : hex;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const action = (process.env.ACTION ?? "status") as "status" | "add" | "remove";
  if (!["status", "add", "remove"].includes(action)) {
    throw new Error(`ACTION must be status|add|remove, got "${action}"`);
  }
  const networkName = hre.network.name;
  const isTron = TRON_NETWORKS.has(networkName);
  const apply = process.env.APPLY === "1";

  const wallets = parseWallets(isTron);
  const idrpAddress = resolveIdrpAddress(networkName, isTron);

  console.log(`network: ${networkName}  action: ${action}  apply: ${apply}`);
  console.log(`IDRP:    ${fmtAddr(idrpAddress, isTron)}`);

  // Discover the list from the token — on-chain beats deployment JSONs.
  let listAddress = process.env.SANCTIONS_LIST_ADDRESS;
  if (!listAddress) {
    const idrp = new Contract(idrpAddress, IDRP_ABI, ethers.provider);
    listAddress = (await idrp.sanctionsList()) as string;
  }
  if (!listAddress || listAddress === ZeroAddress) {
    console.log("sanctionsList() is the zero address — sanctions are NOT wired on this network. Nothing to do.");
    return;
  }
  console.log(`list:    ${fmtAddr(listAddress, isTron)}`);

  const readList = new Contract(listAddress, LIST_ABI, ethers.provider);
  const owner = (await readList.owner().catch(() => null)) as string | null;
  console.log(`owner:   ${owner ? fmtAddr(owner, isTron) : "(no owner() — unexpected contract?)"}`);

  // Status is always available.
  console.log("");
  for (const w of wallets) {
    const sanctioned = (await readList.isSanctioned(w)) as boolean;
    console.log(`isSanctioned(${fmtAddr(w, isTron)}) = ${sanctioned}`);
  }
  if (action === "status") return;

  // ── Write path guards ──
  if (listAddress.toLowerCase() === CHAINALYSIS_ORACLE.toLowerCase()) {
    throw new Error(
      "This chain points at the REAL Chainalysis oracle — we are not its owner and cannot add/remove entries. Chainalysis manages that list.",
    );
  }
  if (MAINNET_NETWORKS.has(networkName) && process.env.ALLOW_MAINNET !== "1") {
    throw new Error(
      `"${networkName}" is a MAINNET — real on-chain state. Re-run with ALLOW_MAINNET=1 only after explicit sign-off (Rule 0).`,
    );
  }

  const signers = await ethers.getSigners();
  const signer =
    (owner &&
      signers.find((s) => s.address.toLowerCase() === owner.toLowerCase())) ??
    signers[0];
  if (owner && signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `None of the configured signers is the list owner ${fmtAddr(owner, isTron)} — the tx would revert (Ownable). Configured: ${signers.map((s) => s.address).join(", ")}`,
    );
  }
  console.log(`\nsigner:  ${fmtAddr(signer.address, isTron)} (list owner ✓)`);

  const fn = action === "add" ? "addToSanctionsList" : "removeFromSanctionsList";
  if (!apply) {
    console.log(
      `\nDRY-RUN — would call ${fn}([${wallets.map((w) => fmtAddr(w, isTron)).join(", ")}]). Re-run with APPLY=1 to send.`,
    );
    return;
  }

  const list = new Contract(listAddress, LIST_ABI, signer);
  const tx = await list[fn](wallets);
  console.log(`\n${fn} tx: ${tx.hash}`);
  await tx.wait();

  for (const w of wallets) {
    const sanctioned = (await readList.isSanctioned(w)) as boolean;
    console.log(`isSanctioned(${fmtAddr(w, isTron)}) = ${sanctioned}`);
  }
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

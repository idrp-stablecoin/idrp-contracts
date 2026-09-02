/**
 * Strict Tron → EVM address conversion for operator-supplied input.
 *
 * WHY THIS EXISTS
 *   The pattern `"0x" + tronWeb.address.toHex(x).slice(2)` assumes `toHex` returns a
 *   41-prefixed 42-char string, which it does for a base58 `T...` address and for a
 *   `0x`-prefixed hex address. Hand it a BARE hex address (no `0x`) and it returns the
 *   input unchanged — 40 chars — so `.slice(2)` eats two real characters and the result
 *   is a different, shorter address that still looks plausible:
 *
 *     9d0a05af0f1fcf33ffa4ec74d3bdbf63e0ff78ba
 *       -> 0x0a05af0f1fcf33ffa4ec74d3bdbf63e0ff78ba      (wrong, and silent)
 *
 *   That matters most for `_legacyDefaultAdminHolders`. `_revokeRole` on an address
 *   that does not hold the role does not revert, so a corrupted entry means the real
 *   DEFAULT_ADMIN is never revoked and survives the upgrade as a hidden admin — with
 *   no error anywhere.
 *
 *   So: accept only what is unambiguous, and verify by converting back.
 */
const TRON_B58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_HEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * @param input  a base58 `T...` address, or a `0x`-prefixed 40-hex address
 * @param label  what this address is, used in the error message
 * @returns      lowercase `0x`-prefixed 20-byte address
 */
export function toEvmAddress(tronWeb: any, input: string, label: string): string {
  const v = (input ?? "").trim();

  if (!TRON_B58.test(v) && !EVM_HEX.test(v)) {
    throw new Error(
      `${label}: "${v}" is not a usable address.\n` +
      `  Accepted: a base58 address (T… , 34 chars) or a 0x-prefixed hex address (0x + 40 hex).\n` +
      `  A bare hex address without the 0x prefix is REJECTED on purpose — it converts\n` +
      `  silently to a different address.`,
    );
  }

  let raw: string;
  try {
    raw = tronWeb.address.toHex(v);
  } catch (e: any) {
    throw new Error(`${label}: "${v}" failed to convert: ${e?.message ?? e}`);
  }

  if (typeof raw !== "string" || raw.length !== 42 || !raw.startsWith("41")) {
    throw new Error(`${label}: "${v}" produced an unexpected hex form "${raw}" — refusing to use it.`);
  }

  const evm = ("0x" + raw.slice(2)).toLowerCase();
  if (!EVM_HEX.test(evm)) {
    throw new Error(`${label}: "${v}" produced an invalid address "${evm}".`);
  }

  // Round-trip: back to base58 and forward again must land on the same bytes.
  const backB58 = tronWeb.address.fromHex(raw);
  if (tronWeb.address.toHex(backB58).toLowerCase() !== raw.toLowerCase()) {
    throw new Error(`${label}: "${v}" does not round-trip cleanly — refusing to use it.`);
  }

  return evm;
}

/** Same, for a comma-separated list. Rejects an empty list and duplicates. */
export function toEvmAddressList(tronWeb: any, input: string, label: string): string[] {
  const parts = (input ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`${label}: parsed to an empty list.`);
  const out = parts.map((p, i) => toEvmAddress(tronWeb, p, `${label}[${i}]`));
  const dupes = out.filter((a, i) => out.indexOf(a) !== i);
  if (dupes.length) throw new Error(`${label}: duplicate entries ${[...new Set(dupes)].join(", ")}`);
  return out;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title  LegacyAccessControlSlots
 * @notice Storage placeholder for the AccessControl stack the IDRP token used to inherit.
 *
 * @dev    The deployed Tron token proxies were initialised while IDRP inherited
 *         `AccessControlUpgradeable`, which itself brings in `ERC165Upgradeable`. Between
 *         them they occupy 100 sequential slots — 50 for ERC165's gap, then
 *         `_roles` plus its 49-slot gap.
 *
 *         v3 removed role-based access control in favour of single-entity authority
 *         slots. Dropping those parents would pull every following variable 100 slots
 *         lower, so a v3 implementation would read `EIP712` — and therefore
 *         `DOMAIN_SEPARATOR` — from the wrong place and silently break `permit()`.
 *
 *         This contract reserves that space instead. It must be inherited in exactly the
 *         position `AccessControlUpgradeable` held: after `ERC20PausableUpgradeable` and
 *         before `ERC20PermitUpgradeable`. A gap declared in the child cannot substitute
 *         for a removed parent, because child storage always comes after every parent.
 *
 *         The old role data is still physically present in these slots on the live
 *         proxies. It is unreachable through this contract, which declares no functions,
 *         but it is NOT erased — see the OZ4/OZ5 notes on dormant roles before ever
 *         reintroducing an AccessControl parent here.
 *
 *         Do not resize, reorder, or add variables.
 */
abstract contract LegacyAccessControlSlots {
    uint256[100] private __legacyAccessControlGap;
}

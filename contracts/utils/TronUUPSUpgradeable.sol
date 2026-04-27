// contracts/utils/TronUUPSUpgradeable.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @title  TronUUPSUpgradeable
 * @notice Drop-in replacement for OpenZeppelin's UUPSUpgradeable that is compatible with
 *         TVM (TRON Virtual Machine).
 *
 * @dev    Problem:
 *         OZ 5.x UUPSUpgradeable uses `address private immutable __self = address(this)`.
 *         The Solidity compiler stores immutable values directly in contract bytecode via the
 *         IMMUTABLE opcode family (PUSH_IMMUTABLE / ASSIGN_IMMUTABLE). TVM does not support
 *         these opcodes, causing compilation or deployment failures on Tron networks.
 *
 *         Solution:
 *         Store `__self` in a dedicated storage slot (keccak256 hash-derived, separate from
 *         the main contract layout) instead of bytecode. The value is written once during
 *         `__TronUUPSUpgradeable_init()` and is functionally equivalent to the immutable.
 *         This contract is safe to use on EVM chains too — the only difference is a single
 *         SLOAD per proxy-check instead of an inline bytecode read.
 *
 *         Usage:
 *         1. Inherit TronUUPSUpgradeable instead of UUPSUpgradeable.
 *         2. Call __TronUUPSUpgradeable_init() inside the contract's initializer.
 *         3. Override _authorizeUpgrade() with your access-control guard.
 */
abstract contract TronUUPSUpgradeable is Initializable {
    // Dedicated storage slot for the implementation self-address.
    // Derived as keccak256("idrp.tron.uups.__self") to avoid collisions with
    // sequentially-allocated Solidity storage slots (which start at slot 0).
    bytes32 private constant _SELF_SLOT =
        keccak256("idrp.tron.uups.__self");

    error TronUUPSUnauthorizedCallContext();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    /// @dev Reverts when called on the bare implementation (i.e., NOT through a proxy).
    modifier onlyProxy() {
        _checkProxy();
        _;
    }

    /// @dev Reverts when called through a proxy (i.e., via delegatecall).
    modifier notDelegated() {
        _checkNotDelegated();
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @dev Write the implementation address into storage once, at initializer time.
    ///      Must be called in the inheriting contract's initializer.
    // solhint-disable-next-line func-name-mixedcase
    function __TronUUPSUpgradeable_init() internal onlyInitializing {
        _storeSelf(address(this));
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /// @notice Returns the ERC-1967 implementation slot UUID (standard UUPS interface).
    function proxiableUUID() external view virtual notDelegated returns (bytes32) {
        return ERC1967Utils.IMPLEMENTATION_SLOT;
    }

    /// @notice Upgrade the proxy to a new implementation and optionally call an initializer.
    /// @dev    Can only be called through the proxy (enforced by onlyProxy).
    function upgradeToAndCall(
        address newImplementation,
        bytes memory data
    ) public payable virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        ERC1967Utils.upgradeToAndCall(newImplementation, data);
    }

    // ─── Internal API ────────────────────────────────────────────────────────

    /// @dev Override this with your authorization guard (e.g., onlyRole(UPGRADER_ROLE)).
    function _authorizeUpgrade(address newImplementation) internal virtual;

    function _checkProxy() internal view virtual {
        address self = _loadSelf();
        // Revert if we are NOT being called via delegatecall through a proxy:
        //   address(this) == self  →  called on implementation directly
        //   getImplementation() != self  →  proxy points to a different implementation
        if (address(this) == self || ERC1967Utils.getImplementation() != self) {
            revert TronUUPSUnauthorizedCallContext();
        }
    }

    function _checkNotDelegated() internal view virtual {
        // Revert if we ARE being called via delegatecall (address(this) is proxy address,
        // not the implementation address we stored in __self).
        if (address(this) != _loadSelf()) {
            revert TronUUPSUnauthorizedCallContext();
        }
    }

    // ─── Storage helpers ─────────────────────────────────────────────────────

    function _loadSelf() private view returns (address self_) {
        bytes32 slot = _SELF_SLOT;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            self_ := sload(slot)
        }
    }

    function _storeSelf(address self_) private {
        bytes32 slot = _SELF_SLOT;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(slot, self_)
        }
    }
}
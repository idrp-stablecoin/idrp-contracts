// contracts/utils/TronUUPSUpgradeable.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/ERC1967/ERC1967UpgradeUpgradeable.sol";

/**
 * @title  TronUUPSUpgradeable
 * @notice Drop-in replacement for OpenZeppelin's UUPSUpgradeable that is compatible with
 *         TVM (TRON Virtual Machine). Compatible with OpenZeppelin v4.x.
 *
 * @dev    Problem:
 *         OZ 5.x UUPSUpgradeable uses `address private immutable __self = address(this)`.
 *         The Solidity compiler stores immutable values directly in contract bytecode via the
 *         IMMUTABLE opcode family (PUSH_IMMUTABLE / ASSIGN_IMMUTABLE). TVM does not support
 *         these opcodes, causing compilation or deployment failures on Tron networks.
 *
 *         OZ 4.x UUPSUpgradeable also uses `address private immutable __self` — same issue.
 *
 *         Solution:
 *         Store `__self` in a dedicated storage slot (keccak256 hash-derived, separate from
 *         the main contract layout) instead of bytecode. The value is written once during
 *         `__TronUUPSUpgradeable_init()` and is functionally equivalent to the immutable.
 *
 *         Differences from OZ v5 version:
 *         - Uses ERC1967UpgradeUpgradeable (OZ v4) instead of ERC1967Utils (OZ v5)
 *         - Uses _upgradeTo/_upgradeToAndCall instead of ERC1967Utils.upgradeToAndCall
 *         - IMPLEMENTATION_SLOT accessed via _getImplementation()
 *
 *         Usage:
 *         1. Inherit TronUUPSUpgradeable instead of UUPSUpgradeable.
 *         2. Call __TronUUPSUpgradeable_init() inside the contract's initializer.
 *         3. Override _authorizeUpgrade() with your access-control guard.
 */
abstract contract TronUUPSUpgradeable is Initializable, ERC1967UpgradeUpgradeable {

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

    // solhint-disable-next-line func-name-mixedcase
    function __UUPSUpgradeable_init() internal onlyInitializing {
        __ERC1967Upgrade_init_unchained();
        _storeSelf(address(this));
    }

    // solhint-disable-next-line func-name-mixedcase
    function __UUPSUpgradeable_init_unchained() internal onlyInitializing {
        _storeSelf(address(this));
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /// @notice Returns the ERC-1967 implementation slot UUID (standard UUPS interface).
    function proxiableUUID() external view virtual notDelegated returns (bytes32) {
        // _IMPLEMENTATION_SLOT is inherited from ERC1967UpgradeUpgradeable
        return _IMPLEMENTATION_SLOT; // 0x360894a...
    }

    /// @notice Upgrade the proxy to a new implementation.
    function upgradeTo(address newImplementation) external virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        _upgradeTo(newImplementation);
    }

    /// @notice Upgrade the proxy to a new implementation and call an initializer.
    function upgradeToAndCall(
        address newImplementation,
        bytes memory data
    ) external payable virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        _upgradeToAndCall(newImplementation, data, true);
    }

    // ─── Internal API ────────────────────────────────────────────────────────

    /// @dev Override this with your authorization guard (e.g., onlyRole(UPGRADER_ROLE)).
    function _authorizeUpgrade(address newImplementation) internal virtual;

    function _checkProxy() internal view virtual {
        address self = _loadSelf();
        // Revert if NOT called via delegatecall through a proxy:
        //   address(this) == self  → called on implementation directly
        //   _getImplementation() != self → proxy points to different implementation
        if (address(this) == self || _getImplementation() != self) {
            revert TronUUPSUnauthorizedCallContext();
        }
    }

    function _checkNotDelegated() internal view virtual {
        // Revert if called via delegatecall (address(this) is proxy, not implementation)
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
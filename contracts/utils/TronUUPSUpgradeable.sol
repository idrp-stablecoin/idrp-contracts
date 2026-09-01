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
 *         OZ UUPSUpgradeable uses `address private immutable __self = address(this)`.
 *         The Solidity compiler stores immutable values directly in contract bytecode via the
 *         IMMUTABLE opcode family (PUSH_IMMUTABLE / ASSIGN_IMMUTABLE). TVM does not support
 *         these opcodes, causing compilation or deployment failures on Tron networks.
 *
 *         Solution:
 *         OZ's immutable stores the IMPLEMENTATION address in bytecode so that in a
 *         delegatecall context the bytecode-embedded value can be compared against
 *         `address(this)` (the proxy) to detect proxy vs. direct-call context.
 *
 *         Since TVM cannot embed immutables in bytecode, we instead store the PROXY
 *         address in a dedicated storage slot during `initialize()`. Because `initialize()`
 *         is called through the proxy via delegatecall, `address(this)` at that point IS
 *         the proxy address — so the stored value is the proxy address.
 *
 *         The checks are therefore inverted relative to OZ's immutable-based approach:
 *
 *           _checkProxy()        — passes when address(this) == stored proxy (we ARE the proxy)
 *           _checkNotDelegated() — passes when address(this) != stored proxy (we are NOT the proxy)
 *
 *         On a fresh implementation whose `_PROXY_SLOT` has never been written (= 0),
 *         `_checkProxy()` reverts (correct: uninitialized impl is not a proxy) and
 *         `_checkNotDelegated()` passes (correct: direct call on implementation).
 *
 *         Differences from OZ v4/v5 version:
 *         - Uses ERC1967UpgradeUpgradeable (OZ v4) instead of ERC1967Utils (OZ v5)
 *         - Uses _upgradeTo/_upgradeToAndCall instead of ERC1967Utils.upgradeToAndCall
 *         - IMPLEMENTATION_SLOT accessed via _getImplementation()
 *
 *         Usage:
 *         1. Inherit TronUUPSUpgradeable instead of UUPSUpgradeable.
 *         2. Call __UUPSUpgradeable_init() inside the contract's initializer.
 *         3. Override _authorizeUpgrade() with your access-control guard.
 */
abstract contract TronUUPSUpgradeable is Initializable, ERC1967UpgradeUpgradeable {

    // Dedicated storage slot for the proxy address.
    // Written once during initialize() (which runs via delegatecall, so address(this) = proxy).
    // Derived via keccak256 to avoid collisions with sequentially-allocated Solidity slots.
    bytes32 private constant _PROXY_SLOT =
        keccak256("idrp.tron.uups.__proxy");

    error TronUUPSUnauthorizedCallContext();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    /// @dev Reverts when NOT called through a proxy (i.e., called directly on implementation).
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
        // address(this) here equals the proxy address because initialize() is called
        // via the proxy's delegatecall — this is the value we want to store.
        _storeProxy(address(this));
    }

    // solhint-disable-next-line func-name-mixedcase
    function __UUPSUpgradeable_init_unchained() internal onlyInitializing {
        _storeProxy(address(this));
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
        // In proxy context (delegatecall): address(this) == proxy == _loadProxy() → pass.
        // Direct call on implementation:   address(this) == impl  != _loadProxy() → revert.
        if (address(this) != _loadProxy()) {
            revert TronUUPSUnauthorizedCallContext();
        }
    }

    function _checkNotDelegated() internal view virtual {
        // Direct call on implementation: address(this) == impl != _loadProxy() → pass.
        // In proxy context (delegatecall): address(this) == proxy == _loadProxy() → revert.
        if (address(this) == _loadProxy()) {
            revert TronUUPSUnauthorizedCallContext();
        }
    }

    // ─── Storage helpers ─────────────────────────────────────────────────────

    function _loadProxy() private view returns (address proxy_) {
        bytes32 slot = _PROXY_SLOT;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            proxy_ := sload(slot)
        }
    }

    function _storeProxy(address proxy_) private {
        bytes32 slot = _PROXY_SLOT;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(slot, proxy_)
        }
    }
}

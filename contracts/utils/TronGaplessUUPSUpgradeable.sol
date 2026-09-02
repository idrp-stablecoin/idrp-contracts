// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC1822ProxiableUpgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/draft-IERC1822Upgradeable.sol";
import {ERC1967UpgradeUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/ERC1967/ERC1967UpgradeUpgradeable.sol";

/**
 * @title  TronGaplessUUPSUpgradeable
 * @notice OpenZeppelin 4.x `UUPSUpgradeable` with the trailing `uint256[50] __gap` removed.
 *         Behaviour is otherwise byte-for-byte the upstream logic.
 *
 * @dev    WHY THIS EXISTS — storage layout, nothing else.
 *
 *         The Tron proxies were initialised with a UUPS variant that carries no trailing
 *         gap, so the contracts' own variables begin at slot 251 (Controller) and the
 *         token's at 504. Inheriting stock `UUPSUpgradeable` appends 50 reserved slots
 *         and pushes every variable 50 places too high, which silently makes the
 *         implementation read unrelated storage. Verified against Tron mainnet:
 *         Controller `idrpToken` at slot 251, `upgrader` at slot 258.
 *
 * @dev    WHY IT KEEPS OZ'S `immutable __self` — deliberately, and this is the important
 *         part.
 *
 *         An earlier in-house variant (`TronUUPSUpgradeable`) replaced the immutable with
 *         a storage slot, because in early 2026 TVM could not execute the immutable
 *         opcodes. **That is no longer true** — an OZ 5 implementation, whose `onlyProxy`
 *         depends entirely on `immutable __self`, was upgraded successfully on Tron Nile
 *         in Sept 2026. TVM executes immutables correctly.
 *
 *         The storage-slot approach carries a trap the immutable does not: the slot is
 *         written only from an initializer, so a proxy that never ran that initializer
 *         reads zero, every upgrade entry point reverts, and the proxy is frozen on that
 *         implementation permanently. That happened to the Nile Controller. Both Tron
 *         mainnet proxies currently read zero in BOTH generations of that slot
 *         (the `__self` and `__proxy` generations), so they are exposed to
 *         exactly the same failure.
 *
 *         Because `__self` lives in bytecode rather than storage, it is correct on every
 *         proxy from the first call, needs no initializer, and cannot be left unset. That
 *         removes the entire deadlock class rather than patching around it.
 *
 * @dev    Since this contract declares NO storage of its own, it is safe to inherit last.
 *         Do not add state variables here.
 */
abstract contract TronGaplessUUPSUpgradeable is
    Initializable,
    IERC1822ProxiableUpgradeable,
    ERC1967UpgradeUpgradeable
{
    /// @dev Address of this implementation, fixed in bytecode at construction.
    address private immutable __self = address(this);

    /// @dev Reverts unless called through a delegatecall from an active proxy.
    modifier onlyProxy() {
        require(address(this) != __self, "Function must be called through delegatecall");
        require(_getImplementation() == __self, "Function must be called through active proxy");
        _;
    }

    /// @dev Reverts when called through a proxy.
    modifier notDelegated() {
        require(address(this) == __self, "UUPSUpgradeable: must not be called through delegatecall");
        _;
    }

    // solhint-disable-next-line func-name-mixedcase
    function __UUPSUpgradeable_init() internal onlyInitializing {}

    // solhint-disable-next-line func-name-mixedcase
    function __UUPSUpgradeable_init_unchained() internal onlyInitializing {}

    /// @notice ERC-1822 implementation slot UUID.
    function proxiableUUID() external view virtual override notDelegated returns (bytes32) {
        return _IMPLEMENTATION_SLOT;
    }

    /// @notice Upgrade the proxy to `newImplementation`.
    function upgradeTo(address newImplementation) public virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        _upgradeToAndCallUUPS(newImplementation, new bytes(0), false);
    }

    /// @notice Upgrade the proxy to `newImplementation` and then call `data` on it.
    function upgradeToAndCall(address newImplementation, bytes memory data) public payable virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        _upgradeToAndCallUUPS(newImplementation, data, true);
    }

    /// @dev Override with the authorisation guard for upgrades.
    function _authorizeUpgrade(address newImplementation) internal virtual;

    // NOTE: no `__gap` here, on purpose. See the layout note above.
}

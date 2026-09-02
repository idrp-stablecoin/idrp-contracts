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
 *         The deployed v2 implementations use stock OZ 4 `UUPSUpgradeable`, gap and
 *         all. This base is NOT needed to match v2 as it stands; it is needed because
 *         of what v3 ADDS.
 *
 *         The Controller's v3 introduces `AccessControlDefaultAdminRulesUpgradeable`,
 *         which occupies 50 slots that v2 did not have. To keep the contract's own
 *         variables where the live proxy has them, 50 slots must be given back
 *         somewhere, and the trailing UUPS gap is the one dropped. It is a swap:
 *         ACDAR takes 50, UUPS gives up 50, net zero.
 *
 *         Measured, by compiling both and reading the live proxy:
 *
 *           Controller  deployed v2                 idrpToken @ 251
 *                       v3 on this base             idrpToken @ 251   <- matches
 *                       v3 on stock UUPSUpgradeable idrpToken @ 301   <- 50 slots out
 *
 *         A 50-slot shift is not a compile error. The implementation would deploy,
 *         upgrade, and then read every variable from the wrong place.
 *
 *         The token does not have the same forcing constraint: it removes
 *         AccessControl+ERC165 and reserves those slots explicitly, so stock
 *         `UUPSUpgradeable` also lands `frozen` on 504. It uses this base anyway, so
 *         both contracts share one UUPS base — mixing them invites a later "cleanup"
 *         that unifies the wrong way — and so the 50 reserved slots are an explicit,
 *         resizable anchor rather than one owned by a dependency.
 *
 * @dev    WHY IT KEEPS OZ'S `immutable __self` — deliberately, and this is the important
 *         part.
 *
 *         An earlier in-house variant (`TronUUPSUpgradeable`) replaced the immutable with
 *         a storage slot, because TVM was believed unable to execute the immutable
 *         opcodes. That premise no longer holds. The live Tron mainnet implementations
 *         are themselves stock OZ 4 UUPS builds, and their deployed bytecode carries
 *         their own address in the five places the compiled artifact leaves as zero
 *         placeholders — which is precisely an immutable, written by the constructor.
 *         TVM executes them correctly.
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

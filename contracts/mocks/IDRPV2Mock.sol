// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// @dev Frozen snapshot of the deployed IDRP v2 implementation. Sourced from
// deployment/logs/contracts/v2.IDRP.sol (Etherscan-verified mainnet code).
// This is what production proxies (ETH/Polygon/BSC/Kaia/Tron) currently run.
//
// Used ONLY by storage-preservation tests for v2 → v3 migration. Storage
// layout matches the deployed v2 byte-for-byte. Function bodies are
// simplified to what tests need.

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract IDRPV2Mock is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    AccessControlUpgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");

    // Sequential storage layout MUST match v2.IDRP.sol exactly.
    mapping(address => bool) public frozen;
    address public depositoryWallet;
    uint256 public maxSupply;
    address public upgrader;

    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;
    address public sanctionsList;

    error NotUpgrader();

    modifier onlyUpgrader() {
        if (_msgSender() != upgrader) revert NotUpgrader();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address superAdmin) public initializer {
        __ERC20_init("IDRP", "IDRP");
        __ERC20Pausable_init();
        __AccessControl_init();
        __ERC20Permit_init("IDRP");
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, superAdmin);
        _grantRole(PAUSER_ROLE, superAdmin);
        _grantRole(MINTER_ROLE, superAdmin);
        _grantRole(FREEZER_ROLE, superAdmin);

        upgrader = superAdmin;
    }

    /// @dev Mirrors deployed v2's initializeV2 — used by v1→v2→v3 storage tests.
    function initializeV2(
        address _upgrader,
        address[] calldata _legacyUpgraderHolders
    ) external reinitializer(2) onlyRole(DEFAULT_ADMIN_ROLE) {
        upgrader = _upgrader;
        bytes32 legacyUpgraderRole = keccak256("UPGRADER_ROLE");
        for (uint256 i = 0; i < _legacyUpgraderHolders.length; i++) {
            _revokeRole(legacyUpgraderRole, _legacyUpgraderHolders[i]);
        }
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setDepositoryWalletRaw(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositoryWallet = wallet;
    }

    function setMaxSupplyRaw(uint256 _maxSupply) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxSupply = _maxSupply;
    }

    function setSanctionsListRaw(address newList) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sanctionsList = newList;
    }

    function setFrozenRaw(address account, bool isFrozen) external onlyRole(DEFAULT_ADMIN_ROLE) {
        frozen[account] = isFrozen;
    }

    function setScheduledUpgradeRaw(address impl, uint256 ts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        scheduledImplementation = impl;
        upgradeScheduledAt = ts;
    }

    function mintRaw(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}
}

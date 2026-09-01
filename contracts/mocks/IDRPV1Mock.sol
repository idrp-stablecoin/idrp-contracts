// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// @dev Frozen snapshot of the deployed IDRP v1 implementation. Sourced from
// deployment/logs/contracts/v1.IDRP.sol (Etherscan-verified mainnet code).
// Used ONLY by storage-preservation tests to deploy a v1 proxy, populate state,
// then upgrade to v2 and/or v3 and assert layout safety.
//
// Function bodies are simplified — only what the tests need to mutate storage.
// Storage layout must match the deployed v1 byte-for-byte.

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract IDRPV1Mock is
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
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    mapping(address => bool) public frozen;
    address public depositoryWallet;

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
        _grantRole(UPGRADER_ROLE, superAdmin);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setDepositoryWalletRaw(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositoryWallet = wallet;
    }

    function setFrozenRaw(address account, bool isFrozen) external onlyRole(DEFAULT_ADMIN_ROLE) {
        frozen[account] = isFrozen;
    }

    function mintRaw(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._beforeTokenTransfer(from, to, value);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}

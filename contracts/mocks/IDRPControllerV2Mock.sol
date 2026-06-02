// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// @dev Frozen snapshot of the deployed IDRPController v2 implementation.
// Sourced from deployment/logs/contracts/v2.IDRPController.sol (Etherscan-
// verified mainnet code). This is what production proxies currently run.
//
// Used ONLY by storage-preservation tests for v2 → v3 migration. Storage
// layout matches the deployed v2 byte-for-byte. Function bodies are
// simplified to what tests need.

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract IDRPControllerV2Mock is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorageDeprecated {
        address _owner;
    }

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant DIRECTOR_ROLE = keccak256("DIRECTOR_ROLE");
    bytes32 public constant COMMISSIONER_ROLE = keccak256("COMMISSIONER_ROLE");

    address public idrpToken;
    uint256 public nonce;

    enum OperationType {
        Mint,
        Burn,
        Freeze,
        Unfreeze,
        Pause,
        Unpause
    }

    struct QuorumRule {
        uint256 minAmount;
        uint256 maxAmount;
        bytes32[] requiredRoles;
    }

    mapping(OperationType => QuorumRule[]) public quorumRules;
    mapping(bytes32 => bool) public usedSignatures;
    bytes32 private DOMAIN_SEPARATOR;

    uint256 public constant MAX_DEADLINE_DURATION = 7 days;
    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;
    address public upgrader;

    error NotUpgrader();

    modifier onlyUpgrader() {
        if (msg.sender != upgrader) revert NotUpgrader();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _idrpToken, address _safeAddress) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        idrpToken = _idrpToken;

        _grantRole(DEFAULT_ADMIN_ROLE, _safeAddress);
        _grantRole(ADMIN_ROLE, _safeAddress);

        upgrader = _safeAddress;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("IDRPController")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Mirrors deployed v2's initializeV2 (MINOR-2 migration from Ownable to upgrader).
    function initializeV2(
        address _upgrader
    ) external reinitializer(2) onlyRole(DEFAULT_ADMIN_ROLE) {
        upgrader = _upgrader;
    }

    function setQuorumRulesRaw(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) external onlyRole(ADMIN_ROLE) {
        delete quorumRules[operationType];
        for (uint256 i = 0; i < rules.length; i++) {
            quorumRules[operationType].push(rules[i]);
        }
    }

    function setScheduledImplementationRaw(address impl, uint256 ts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        scheduledImplementation = impl;
        upgradeScheduledAt = ts;
    }

    function setUsedSignatureRaw(bytes32 h, bool used) external onlyRole(DEFAULT_ADMIN_ROLE) {
        usedSignatures[h] = used;
    }

    function setNonceRaw(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
        nonce = n;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}
}

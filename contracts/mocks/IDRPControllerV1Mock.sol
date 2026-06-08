// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// @dev Frozen snapshot of the deployed IDRPController v1 implementation.
// Sourced from deployment/logs/contracts/v1.IDRPController.sol (Etherscan-
// verified mainnet initial-deploy code). v1 inherits OwnableUpgradeable AND
// AccessControlUpgradeable; upgrade auth is `onlyOwner` (audit MINOR-2 later
// migrated this to single-address `upgrader`).
//
// Used ONLY by storage-preservation tests (MINOR-2-* and the new v1→v3 path).
// Storage layout matches the deployed v1 byte-for-byte. Function bodies are
// simplified to what tests need.
//
// Do NOT modify this file unless you also update the storage-preservation
// test fixture. Production code lives in contracts/IDRPController.sol.

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract IDRPControllerV1Mock is
    Initializable,
    AccessControlUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _idrpToken,
        address _safeAddress
    ) public initializer {
        __AccessControl_init();
        __Ownable_init(_safeAddress);
        __UUPSUpgradeable_init();

        idrpToken = _idrpToken;

        _grantRole(DEFAULT_ADMIN_ROLE, _safeAddress);
        _grantRole(ADMIN_ROLE, _safeAddress);

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

    // Mirrors v1 access control: onlyOwner. Simplified — no full quorum-rule
    // validation logic, just enough to write into the mapping for layout tests.
    function setQuorumRulesRaw(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) external onlyOwner {
        delete quorumRules[operationType];
        for (uint256 i = 0; i < rules.length; i++) {
            quorumRules[operationType].push(rules[i]);
        }
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}
}

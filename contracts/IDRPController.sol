// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Interface for IDRP-specific functions
interface IIDRP {
    function mint(uint256 amount) external;

    function burn(address from, uint256 amount) external;

    function freeze(address account) external;

    function unfreeze(address account) external;

    function pause() external;

    function unpause() external;
}

contract IDRPController is
    Initializable,
    AccessControlUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant DIRECTOR_ROLE = keccak256("DIRECTOR_ROLE");
    bytes32 public constant COMMISSIONER_ROLE = keccak256("COMMISSIONER_ROLE");

    address public idrpToken;
    uint256 public nonce;

    // Operation types
    enum OperationType {
        Mint,
        Burn,
        Freeze,
        Unfreeze,
        Pause,
        Unpause
    }

    // Quorum rule structure
    struct QuorumRule {
        uint256 minAmount;
        uint256 maxAmount;
        bytes32[] requiredRoles;
    }

    // Mapping of operation types to their quorum rules
    mapping(OperationType => QuorumRule[]) public quorumRules;

    // Mapping to track used signatures
    mapping(bytes32 => bool) public usedSignatures;

    // Domain separator for EIP-712
    bytes32 private DOMAIN_SEPARATOR;

    // Typehash for operation approvals
    bytes32 private constant OPERATION_TYPEHASH =
        keccak256(
            "Operation(address to,uint8 operationType,uint256 amount,uint256 nonce,uint256 deadline)"
        );

    // Events
    event OperationExecuted(
        OperationType indexed operationType,
        address indexed to,
        uint256 amount,
        uint256 indexed nonce
    );
    event QuorumRulesUpdated(OperationType indexed operationType);
    event TokensWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );

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

        // Setup roles - set Safe address as the admin
        _grantRole(DEFAULT_ADMIN_ROLE, _safeAddress);
        _grantRole(ADMIN_ROLE, _safeAddress);

        // Initialize domain separator for EIP-712
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

    // Set quorum rules for an operation type
    function setQuorumRules(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) external onlyRole(ADMIN_ROLE) {
        delete quorumRules[operationType];
        for (uint256 i = 0; i < rules.length; i++) {
            quorumRules[operationType].push(rules[i]);
        }

        emit QuorumRulesUpdated(operationType);
    }

    // Main execution function
    function executeOperation(
        OperationType operationType,
        address to,
        uint256 amount,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        // Ensure only Admin, Officer, Manager, Director, or Commissioner can call this
        require(
            hasRole(ADMIN_ROLE, msg.sender) ||
                hasRole(OFFICER_ROLE, msg.sender) ||
                hasRole(MANAGER_ROLE, msg.sender) ||
                hasRole(DIRECTOR_ROLE, msg.sender) ||
                hasRole(COMMISSIONER_ROLE, msg.sender),
            "Caller does not have the required role"
        );

        // Ensure the operation is not expired
        require(block.timestamp <= deadline, "Operation expired");

        // Get the appropriate quorum rule for this operation and amount
        QuorumRule memory rule = getQuorumRule(operationType, amount);

        // Hash the operation data
        bytes32 operationHash = getOperationHash(
            to,
            uint8(operationType),
            amount,
            nonce,
            deadline
        );

        // Verify signatures based on operation type
        if (operationType == OperationType.Unpause) {
            verifyUnpauseSignatures(operationHash, signatures);
        } else {
            verifySignatures(operationHash, rule.requiredRoles, signatures);
        }

        // Mark operation hash as used to prevent replay
        usedSignatures[operationHash] = true;

        // Increment nonce to prevent replay of future transactions
        nonce++;

        // Execute the operation
        if (operationType == OperationType.Mint) {
            IIDRP(idrpToken).mint(amount);
        } else if (operationType == OperationType.Burn) {
            IIDRP(idrpToken).burn(to, amount);
        } else if (operationType == OperationType.Freeze) {
            IIDRP(idrpToken).freeze(to);
        } else if (operationType == OperationType.Unfreeze) {
            IIDRP(idrpToken).unfreeze(to);
        } else if (operationType == OperationType.Pause) {
            IIDRP(idrpToken).pause();
        } else if (operationType == OperationType.Unpause) {
            IIDRP(idrpToken).unpause();
        }

        emit OperationExecuted(operationType, to, amount, nonce - 1);
    }

    // Specialized function to verify unpause signatures with OR logic
    function verifyUnpauseSignatures(
        bytes32 operationHash,
        bytes[] calldata signatures
    ) internal view {
        require(!usedSignatures[operationHash], "Signatures already used");
        
        bool hasOfficer = false;
        bool hasManager = false;
        bool hasDirector = false;
        bool hasCommissioner = false;
        
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = recoverSigner(operationHash, signatures[i]);
            
            if (hasRole(OFFICER_ROLE, signer)) hasOfficer = true;
            if (hasRole(MANAGER_ROLE, signer)) hasManager = true;
            if (hasRole(DIRECTOR_ROLE, signer)) hasDirector = true;
            if (hasRole(COMMISSIONER_ROLE, signer)) hasCommissioner = true;
        }
        
        // Check for valid combinations:
        // 1. officer + manager + director
        // 2. manager + director + commissioner
        bool validCombination = 
            (hasOfficer && hasManager && hasDirector) || 
            (hasManager && hasDirector && hasCommissioner);
            
        require(validCombination, "Invalid signature combination for unpause");
    }

    // Function to withdraw other tokens that might be sent to this contract
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        // Don't allow withdrawing the IDRP token itself through this method
        require(token != idrpToken, "Cannot withdraw IDRP token");

        IERC20(token).safeTransfer(to, amount);
        emit TokensWithdrawn(token, to, amount);
    }

    // Helper function to get the appropriate quorum rule
    function getQuorumRule(
        OperationType operationType,
        uint256 amount
    ) public view returns (QuorumRule memory) {
        QuorumRule[] storage rules = quorumRules[operationType];

        for (uint256 i = 0; i < rules.length; i++) {
            if (amount >= rules[i].minAmount && amount < rules[i].maxAmount) {
                return rules[i];
            }
        }

        revert("No matching quorum rule found");
    }

    // Helper to get the EIP-712 hash for an operation
    function getOperationHash(
        address to,
        uint8 operationType,
        uint256 amount,
        uint256 _nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                OPERATION_TYPEHASH,
                to,
                operationType,
                amount,
                _nonce,
                deadline
            )
        );

        return
            keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
            );
    }

    // Verify that all required signatures are present and valid
    function verifySignatures(
        bytes32 operationHash,
        bytes32[] memory requiredRoles,
        bytes[] calldata signatures
    ) internal view {
        require(!usedSignatures[operationHash], "Signatures already used");

        // For each required role, verify at least one signature from that role is present
        for (uint256 i = 0; i < requiredRoles.length; i++) {
            bool roleSignatureFound = false;
            bytes32 role = requiredRoles[i];

            for (uint256 j = 0; j < signatures.length; j++) {
                address recoveredSigner = recoverSigner(
                    operationHash,
                    signatures[j]
                );
                if (hasRole(role, recoveredSigner)) {
                    roleSignatureFound = true;
                    break;
                }
            }

            require(
                roleSignatureFound,
                string(abi.encodePacked("Missing signature for role: ", role))
            );
        }
    }

    // Helper to recover the signer of a signature
    function recoverSigner(
        bytes32 hash,
        bytes calldata signature
    ) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) {
            v += 27;
        }

        require(v == 27 || v == 28, "Invalid signature 'v' value");

        return ecrecover(hash, v, r, s);
    }

    // Override required by UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}
}

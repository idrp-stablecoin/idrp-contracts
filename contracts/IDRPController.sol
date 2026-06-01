// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
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
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /// @dev Preserved storage namespace of the removed OwnableUpgradeable parent
    ///      (audit v4.0 finding V4-2). OZ Upgrades requires the namespace to
    ///      remain declared so v1→v2 layout comparison passes; the slot still
    ///      holds its legacy `_owner` value but is no longer read by any path.
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorageDeprecated {
        address _owner;
    }

    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant DIRECTOR_ROLE = keccak256("DIRECTOR_ROLE");
    bytes32 public constant COMMISSIONER_ROLE = keccak256("COMMISSIONER_ROLE");

    address public idrpToken;
    // @dev Deprecated: nonce is no longer used. Replay protection is via usedSignatures[operationHash].
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

    // Typehash for operation approvals - updated to use operationIdentifier instead of nonce
    bytes32 private constant OPERATION_TYPEHASH =
        keccak256(
            "Operation(address to,uint8 operationType,uint256 amount,string operationIdentifier,uint256 deadline)"
        );

    // Max deadline duration for operations
    uint256 public constant MAX_DEADLINE_DURATION = 7 days;

    // Upgrade timelock
    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;

    // Single-address upgrader (audit v4.0 finding V4-2: removed OwnableUpgradeable
    // in favour of an explicit, rotatable upgrader — same shape as IDRP.sol).
    // Appended at the end of storage so existing v1 proxies preserve their layout
    // on upgrade (slot is zero-initialized → migration runs via initializeV2).
    address public upgrader;

    // Pending state for the quorum-rule timelock. Changes to existing rules go
    // through schedule → wait UPGRADE_DELAY → apply. Appended at the end of
    // storage (UUPS-safe): existing proxies zero-initialize these.
    struct PendingQuorum {
        bool exists;
        uint256 scheduledAt;
        QuorumRule[] rules;
    }
    mapping(OperationType => PendingQuorum) private pendingQuorumRules;

    // Events
    event OperationExecuted(
        OperationType indexed operationType,
        address indexed to,
        uint256 amount,
        string indexed operationIdentifier
    );
    event QuorumRulesUpdated(
        OperationType indexed operationType,
        uint256 rulesCount,
        address indexed updatedBy
    );
    // Lifecycle events for the quorum-rule timelock.
    event QuorumRulesScheduled(
        OperationType indexed operationType,
        uint256 rulesCount,
        uint256 executableAfter,
        address indexed scheduledBy
    );
    event QuorumRulesCancelled(
        OperationType indexed operationType,
        address indexed cancelledBy
    );
    event TokensWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event UpgradeScheduled(
        address indexed newImplementation,
        uint256 executableAfter
    );
    event UpgradeCancelled(
        address indexed newImplementation,
        address indexed cancelledBy
    );
    event UpgraderUpdated(
        address indexed oldUpgrader,
        address indexed newUpgrader
    );

    // Errors
    error NotUpgrader();

    // Modifiers
    modifier onlyUpgrader() {
        if (msg.sender != upgrader) revert NotUpgrader();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _idrpToken,
        address _safeAddress
    ) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        idrpToken = _idrpToken;

        // Setup roles - set Safe address as the admin
        _grantRole(DEFAULT_ADMIN_ROLE, _safeAddress);
        _grantRole(ADMIN_ROLE, _safeAddress);

        // Single-address upgrader. Safe is the same address that was previously
        // wired to OwnableUpgradeable's _owner — fresh deploys keep the same
        // authorisation semantics, just via the rotatable upgrader slot.
        upgrader = _safeAddress;
        emit UpgraderUpdated(address(0), _safeAddress);

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

    /// @notice One-time migration for proxies originally deployed with OwnableUpgradeable.
    /// @dev Sets `upgrader` for existing v1 proxies whose slot is still zero.
    ///      Gated by DEFAULT_ADMIN_ROLE so an attacker cannot frontrun the
    ///      post-upgrade migration tx (audit v4.0 finding V4-1, mirrored on
    ///      controller for V4-2). The orphaned `_owner` slot in the OZ Ownable
    ///      ERC-7201 namespace is harmless — it is no longer read by any path.
    function initializeV2(
        address _upgrader
    ) external reinitializer(2) onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_upgrader != address(0), "Invalid upgrader");
        address oldUpgrader = upgrader;
        upgrader = _upgrader;
        emit UpgraderUpdated(oldUpgrader, _upgrader);
    }

    /// @notice Rotate the single upgrader address. Only DEFAULT_ADMIN_ROLE (Safe) may rotate.
    function setUpgrader(
        address _upgrader
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_upgrader != address(0), "Invalid upgrader");
        address oldUpgrader = upgrader;
        upgrader = _upgrader;
        emit UpgraderUpdated(oldUpgrader, _upgrader);
    }

    // Quorum-rule management. First-time setup (no rules yet for an op type)
    // applies instantly via setQuorumRules. Any CHANGE to an op type that already
    // has rules must go through scheduleQuorumRules → wait UPGRADE_DELAY →
    // applyQuorumRules; cancelQuorumRules aborts a pending change.

    // Validates ranges are contiguous: start at 0, no gaps, end at type(uint256).max
    function _validateQuorumRules(QuorumRule[] calldata rules) internal pure {
        require(rules.length > 0, "Rules cannot be empty");

        for (uint256 i = 0; i < rules.length; i++) {
            require(
                rules[i].minAmount < rules[i].maxAmount,
                "Invalid range"
            );
            if (i == 0) {
                require(rules[i].minAmount == 0, "First rule must start at 0");
            } else {
                require(
                    rules[i].minAmount == rules[i - 1].maxAmount,
                    "Gap between rules"
                );
            }
        }
        require(
            rules[rules.length - 1].maxAmount == type(uint256).max,
            "Last rule must cover max amount"
        );
    }

    function _writeQuorumRules(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) internal {
        delete quorumRules[operationType];
        for (uint256 i = 0; i < rules.length; i++) {
            quorumRules[operationType].push(rules[i]);
        }
        emit QuorumRulesUpdated(operationType, rules.length, msg.sender);
    }

    /// @notice Set quorum rules. First-time setup applies instantly; changing an
    ///         op type that already has rules is rejected and must use the
    ///         timelocked scheduleQuorumRules/applyQuorumRules path.
    function setQuorumRules(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) external onlyRole(ADMIN_ROLE) {
        require(
            quorumRules[operationType].length == 0,
            "Rules exist: use schedule"
        );
        _validateQuorumRules(rules);
        _writeQuorumRules(operationType, rules);
    }

    /// @notice Schedule a CHANGE to existing quorum rules. Validates eagerly
    ///         (fail fast), then queues behind the UPGRADE_DELAY timelock.
    function scheduleQuorumRules(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) external onlyRole(ADMIN_ROLE) {
        _validateQuorumRules(rules);

        PendingQuorum storage pending = pendingQuorumRules[operationType];
        delete pending.rules;
        for (uint256 i = 0; i < rules.length; i++) {
            pending.rules.push(rules[i]);
        }
        pending.exists = true;
        pending.scheduledAt = block.timestamp;

        emit QuorumRulesScheduled(
            operationType,
            rules.length,
            block.timestamp + UPGRADE_DELAY,
            msg.sender
        );
    }

    /// @notice Apply a previously scheduled quorum-rule change once the timelock
    ///         has elapsed. Anyone with ADMIN_ROLE can finalise.
    function applyQuorumRules(
        OperationType operationType
    ) external onlyRole(ADMIN_ROLE) {
        PendingQuorum storage pending = pendingQuorumRules[operationType];
        require(pending.exists, "No pending quorum rules");
        require(
            block.timestamp >= pending.scheduledAt + UPGRADE_DELAY,
            "Timelock not expired"
        );

        delete quorumRules[operationType];
        uint256 len = pending.rules.length;
        for (uint256 i = 0; i < len; i++) {
            quorumRules[operationType].push(pending.rules[i]);
        }

        delete pendingQuorumRules[operationType];

        emit QuorumRulesUpdated(operationType, len, msg.sender);
    }

    /// @notice Cancel a pending (not-yet-applied) quorum-rule change.
    function cancelQuorumRules(
        OperationType operationType
    ) external onlyRole(ADMIN_ROLE) {
        require(pendingQuorumRules[operationType].exists, "No pending quorum rules");
        delete pendingQuorumRules[operationType];
        emit QuorumRulesCancelled(operationType, msg.sender);
    }

    /// @notice View a pending quorum-rule change (rules + when it becomes executable).
    function getPendingQuorumRules(
        OperationType operationType
    ) external view returns (bool exists, uint256 executableAfter, QuorumRule[] memory rules) {
        PendingQuorum storage pending = pendingQuorumRules[operationType];
        uint256 execAfter = pending.exists
            ? pending.scheduledAt + UPGRADE_DELAY
            : 0;
        return (pending.exists, execAfter, pending.rules);
    }

    // Main execution function - updated to use operationIdentifier instead of nonce
    function executeOperation(
        OperationType operationType,
        address to,
        uint256 amount,
        string calldata operationIdentifier,
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
        require(
            deadline <= block.timestamp + MAX_DEADLINE_DURATION,
            "Deadline too far"
        );

        // Validate 'to' parameter based on operation type
        if (
            operationType == OperationType.Mint ||
            operationType == OperationType.Pause ||
            operationType == OperationType.Unpause
        ) {
            require(to == address(0), "Invalid 'to' for this operation");
        } else {
            require(to != address(0), "Invalid target address");
        }

        // Get the appropriate quorum rule for this operation and amount
        QuorumRule memory rule = getQuorumRule(operationType, amount);

        // Hash the operation data - using operationIdentifier instead of nonce
        bytes32 operationHash = getOperationHash(
            to,
            uint8(operationType),
            amount,
            operationIdentifier,
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

        emit OperationExecuted(operationType, to, amount, operationIdentifier);
    }

    // Specialized function to verify unpause signatures with OR logic
    // Each signer can only contribute to one role to prevent multi-role bypass
    function verifyUnpauseSignatures(
        bytes32 operationHash,
        bytes[] calldata signatures
    ) internal view {
        require(!usedSignatures[operationHash], "Operation hash already used");

        bool hasOfficer = false;
        bool hasManager = false;
        bool hasDirector = false;
        bool hasCommissioner = false;

        address[] memory seenSigners = new address[](signatures.length);
        uint256 seenCount = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = recoverSigner(operationHash, signatures[i]);

            // Check duplicate signer
            bool isDuplicate = false;
            for (uint256 j = 0; j < seenCount; j++) {
                if (seenSigners[j] == signer) {
                    isDuplicate = true;
                    break;
                }
            }
            if (isDuplicate) continue;

            seenSigners[seenCount] = signer;
            seenCount++;

            // Each signer only contributes to first matching role
            if (!hasOfficer && hasRole(OFFICER_ROLE, signer)) hasOfficer = true;
            else if (!hasManager && hasRole(MANAGER_ROLE, signer)) hasManager = true;
            else if (!hasDirector && hasRole(DIRECTOR_ROLE, signer)) hasDirector = true;
            else if (!hasCommissioner && hasRole(COMMISSIONER_ROLE, signer)) hasCommissioner = true;
        }

        // Check for valid combinations:
        // 1. officer + manager + director
        // 2. manager + director + commissioner
        bool validCombination =
            (hasOfficer && hasManager && hasDirector) ||
            (hasManager && hasDirector && hasCommissioner);

        require(validCombination, "Invalid signature combination for unpause");
    }

    // Function to withdraw tokens that might be sent to this contract
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(to != address(0), "Invalid recipient address");
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

    // Helper to get the EIP-712 hash for an operation - updated to use operationIdentifier
    function getOperationHash(
        address to,
        uint8 operationType,
        uint256 amount,
        string calldata operationIdentifier,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                OPERATION_TYPEHASH,
                to,
                operationType,
                amount,
                keccak256(bytes(operationIdentifier)),
                deadline
            )
        );

        return
            keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
            );
    }

    // Verify that all required signatures are present and valid
    // Each signer can only satisfy one role to prevent multi-role bypass
    function verifySignatures(
        bytes32 operationHash,
        bytes32[] memory requiredRoles,
        bytes[] calldata signatures
    ) internal view {
        require(!usedSignatures[operationHash], "Operation hash already used");

        address[] memory usedSigners = new address[](requiredRoles.length);
        uint256 usedCount = 0;

        // For each required role, verify at least one signature from that role is present
        for (uint256 i = 0; i < requiredRoles.length; i++) {
            bool roleSignatureFound = false;
            bytes32 role = requiredRoles[i];

            for (uint256 j = 0; j < signatures.length; j++) {
                address recoveredSigner = recoverSigner(
                    operationHash,
                    signatures[j]
                );

                // Check if this signer was already used for another role
                bool alreadyUsed = false;
                for (uint256 k = 0; k < usedCount; k++) {
                    if (usedSigners[k] == recoveredSigner) {
                        alreadyUsed = true;
                        break;
                    }
                }

                if (!alreadyUsed && hasRole(role, recoveredSigner)) {
                    usedSigners[usedCount] = recoveredSigner;
                    usedCount++;
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

    // Schedule an upgrade with 48h timelock
    function scheduleUpgrade(
        address newImplementation
    ) external onlyUpgrader {
        require(
            newImplementation != address(0),
            "Invalid implementation address"
        );
        scheduledImplementation = newImplementation;
        upgradeScheduledAt = block.timestamp;
        emit UpgradeScheduled(
            newImplementation,
            block.timestamp + UPGRADE_DELAY
        );
    }

    // Cancel a scheduled upgrade
    function cancelUpgrade() external onlyUpgrader {
        address cancelled = scheduledImplementation;
        require(cancelled != address(0), "No pending upgrade");
        scheduledImplementation = address(0);
        upgradeScheduledAt = 0;
        emit UpgradeCancelled(cancelled, msg.sender);
    }

    // Override required by UUPSUpgradeable — enforces timelock
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyUpgrader {
        require(
            newImplementation == scheduledImplementation,
            "Upgrade not scheduled"
        );
        require(
            block.timestamp >= upgradeScheduledAt + UPGRADE_DELAY,
            "Timelock not expired"
        );
        scheduledImplementation = address(0);
        upgradeScheduledAt = 0;
    }
}

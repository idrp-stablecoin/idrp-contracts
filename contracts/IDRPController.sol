// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {TronUUPSUpgradeable} from "./utils/TronUUPSUpgradeable.sol";

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
    TronUUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant DIRECTOR_ROLE = keccak256("DIRECTOR_ROLE");
    bytes32 public constant COMMISSIONER_ROLE = keccak256("COMMISSIONER_ROLE");

    address public idrpToken;

    /// @custom:storage-location
    /// @dev DEPRECATED — no longer used for replay protection.
    ///      Replay protection is provided by usedSignatures[operationHash].
    ///      The storage slot is retained (not removed) to preserve the proxy
    ///      storage layout for already-deployed contracts.
    uint256 public nonce_deprecated;

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

    // Typehash for upgrade scheduling
    bytes32 private constant UPGRADE_TYPEHASH =
        keccak256(
            "UpgradeSchedule(address newImplementation,string operationIdentifier,uint256 deadline)"
        );

    // Minimum time between scheduling and executing an upgrade (OJK notification window)
    uint256 public constant UPGRADE_TIMELOCK = 48 hours;

    // Maximum window a signed deadline may extend into the future.
    // Limits the exploitation window of a stolen or leaked signature.
    uint256 public constant MAX_DEADLINE_WINDOW = 7 days;

    struct PendingUpgrade {
        address newImplementation;
        uint256 scheduledAt;
        string operationIdentifier;
    }

    PendingUpgrade public pendingUpgrade;

    // Events
    event OperationExecuted(
        OperationType indexed operationType,
        address indexed to,
        uint256 amount,
        string indexed operationIdentifier
    );
    /// @notice Emitted every time TAP quorum rules are changed.
    /// @dev    oldRules and newRules are included so the full TAP history can be
    ///         reconstructed from on-chain events alone (OJK audit requirement).
    event QuorumRulesUpdated(
        OperationType indexed operationType,
        QuorumRule[] oldRules,
        QuorumRule[] newRules,
        address indexed updatedBy,
        uint256 timestamp
    );
    event TokensWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event UpgradeScheduled(
        address indexed newImplementation,
        uint256 scheduledAt,
        uint256 executableAt,
        string operationIdentifier
    );
    event UpgradeCancelled(
        address indexed newImplementation,
        string operationIdentifier
    );
    event UpgradeExecuted(
        address indexed newImplementation,
        string operationIdentifier
    );

    /// @dev Reverts when a set of quorum rules does not form complete, contiguous
    ///      coverage from 0 to type(uint256).max.
    error QuorumRulesInvalid(string reason);
    error InvalidSignatureLength();
    error InvalidSignatureV();
    error DuplicateSigner();
    error UnauthorizedCaller();

    /// @dev Returns true if `account` holds at least one operational role.
    function _hasAnyCallerRole(address account) internal view returns (bool) {
        return
            hasRole(ADMIN_ROLE, account) ||
            hasRole(OFFICER_ROLE, account) ||
            hasRole(MANAGER_ROLE, account) ||
            hasRole(DIRECTOR_ROLE, account) ||
            hasRole(COMMISSIONER_ROLE, account);
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
        __Ownable_init(_safeAddress);
        __TronUUPSUpgradeable_init();

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
        // Validate coverage: rules must be sorted, contiguous, and span [0, uint256.max).
        // This ensures no amount can ever slip through a gap and cause an unexpected revert
        // in executeOperation() after TAP rule updates.
        if (rules.length == 0) revert QuorumRulesInvalid("At least one rule required");
        if (rules[0].minAmount != 0) revert QuorumRulesInvalid("First rule must start at 0");
        for (uint256 i = 0; i < rules.length; i++) {
            if (rules[i].minAmount >= rules[i].maxAmount)
                revert QuorumRulesInvalid("minAmount must be < maxAmount");
            if (rules[i].requiredRoles.length == 0)
                revert QuorumRulesInvalid("Rule must require at least one role");
            if (i > 0 && rules[i].minAmount != rules[i - 1].maxAmount)
                revert QuorumRulesInvalid("Rules must be contiguous with no gaps or overlaps");
        }
        if (rules[rules.length - 1].maxAmount != type(uint256).max)
            revert QuorumRulesInvalid("Last rule maxAmount must be type(uint256).max");

        // Snapshot the current rules before overwriting so they appear in the event log.
        QuorumRule[] storage existing = quorumRules[operationType];
        QuorumRule[] memory oldRules = new QuorumRule[](existing.length);
        for (uint256 i = 0; i < existing.length; i++) {
            oldRules[i] = existing[i];
        }

        delete quorumRules[operationType];
        for (uint256 i = 0; i < rules.length; i++) {
            quorumRules[operationType].push(rules[i]);
        }

        // Emit full before/after snapshot for OJK audit trail.
        QuorumRule[] memory newRules = new QuorumRule[](rules.length);
        for (uint256 i = 0; i < rules.length; i++) {
            newRules[i] = rules[i];
        }
        emit QuorumRulesUpdated(operationType, oldRules, newRules, msg.sender, block.timestamp);
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
        // Cache msg.sender and block.timestamp to avoid repeated opcode costs
        address caller = msg.sender;
        uint256 ts = block.timestamp;

        if (!_hasAnyCallerRole(caller)) revert UnauthorizedCaller();

        // Ensure the operation is not expired and has not been set too far in the future
        require(ts <= deadline, "Operation expired");
        require(deadline <= ts + MAX_DEADLINE_WINDOW, "Deadline exceeds maximum");

        // Validate the 'to' parameter semantics per operation type.
        // Mint/Pause/Unpause: destination is implicit (depositoryWallet / token contract),
        //   so 'to' must be address(0) to keep signed messages unambiguous.
        // Burn/Freeze/Unfreeze: 'to' is the target account and must be a real address.
        if (
            operationType == OperationType.Mint ||
            operationType == OperationType.Pause ||
            operationType == OperationType.Unpause
        ) {
            require(to == address(0), "'to' must be address(0) for this operation");
        } else {
            // Burn, Freeze, Unfreeze
            require(to != address(0), "Invalid target address");
        }

        // Cache idrpToken — single SLOAD instead of one per branch
        address token = idrpToken;

        // Get the appropriate quorum rule for this operation and amount
        QuorumRule memory rule = getQuorumRule(operationType, amount);

        // Hash the operation data
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
            IIDRP(token).mint(amount);
        } else if (operationType == OperationType.Burn) {
            IIDRP(token).burn(to, amount);
        } else if (operationType == OperationType.Freeze) {
            IIDRP(token).freeze(to);
        } else if (operationType == OperationType.Unfreeze) {
            IIDRP(token).unfreeze(to);
        } else if (operationType == OperationType.Pause) {
            IIDRP(token).pause();
        } else if (operationType == OperationType.Unpause) {
            IIDRP(token).unpause();
        }

        emit OperationExecuted(operationType, to, amount, operationIdentifier);
    }

    // Specialized function to verify unpause signatures with OR logic
    function verifyUnpauseSignatures(
        bytes32 operationHash,
        bytes[] calldata signatures
    ) internal view {
        require(!usedSignatures[operationHash], "Operation hash already used");

        address[] memory signers = _recoverUniqueSigners(operationHash, signatures);
        uint256 sigLen = signers.length;

        bool hasOfficer;
        bool hasManager;
        bool hasDirector;
        bool hasCommissioner;

        for (uint256 i = 0; i < sigLen; ) {
            address s = signers[i];
            // Greedy assignment: once a flag is set, skip further checks for that role.
            // Sentinel address(1) marks a slot as already consumed.
            if (!hasOfficer && hasRole(OFFICER_ROLE, s)) {
                hasOfficer = true;
                signers[i] = address(1);
            } else if (!hasManager && hasRole(MANAGER_ROLE, s)) {
                hasManager = true;
                signers[i] = address(1);
            } else if (!hasDirector && hasRole(DIRECTOR_ROLE, s)) {
                hasDirector = true;
                signers[i] = address(1);
            } else if (!hasCommissioner && hasRole(COMMISSIONER_ROLE, s)) {
                hasCommissioner = true;
                signers[i] = address(1);
            }
            unchecked { ++i; }
        }

        require(
            (hasOfficer && hasManager && hasDirector) ||
            (hasManager && hasDirector && hasCommissioner),
            "Invalid signature combination for unpause"
        );
    }

    // Function to withdraw tokens that might be sent to this contract
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
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
    function verifySignatures(
        bytes32 operationHash,
        bytes32[] memory requiredRoles,
        bytes[] calldata signatures
    ) internal view {
        require(!usedSignatures[operationHash], "Operation hash already used");

        address[] memory signers = _recoverUniqueSigners(operationHash, signatures);
        uint256 sigLen = signers.length;
        // Sentinel: overwrite a used signer slot with address(1) to mark it consumed
        // without allocating a separate bool[] array.
        for (uint256 i = 0; i < requiredRoles.length; ) {
            bool found = false;
            bytes32 role = requiredRoles[i];
            for (uint256 j = 0; j < sigLen; ) {
                address s = signers[j];
                if (s > address(1) && hasRole(role, s)) {
                    signers[j] = address(1); // mark consumed
                    found = true;
                    break;
                }
                unchecked { ++j; }
            }
            require(found, string(abi.encodePacked("Missing signature for role: ", requiredRoles[i])));
            unchecked { ++i; }
        }
    }

    // Helper to recover the signer of a signature
    function recoverSigner(
        bytes32 hash,
        bytes calldata signature
    ) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignatureV();

        return ecrecover(hash, v, r, s);
    }

    /// @dev Recover all signers and revert on duplicates.
    ///      Uses address(1) as a "used" sentinel to avoid allocating a second bool[] array,
    ///      saving one memory allocation per call on Tron (Energy-efficient).
    function _recoverUniqueSigners(
        bytes32 operationHash,
        bytes[] calldata signatures
    ) internal pure returns (address[] memory signers) {
        uint256 len = signatures.length;
        signers = new address[](len);
        for (uint256 i = 0; i < len; ) {
            address recovered = recoverSigner(operationHash, signatures[i]);
            for (uint256 j = 0; j < i; ) {
                if (signers[j] == recovered) revert DuplicateSigner();
                unchecked { ++j; }
            }
            signers[i] = recovered;
            unchecked { ++i; }
        }
    }

    // ─── Upgrade scheduling ────────────────────────────────────────────────────

    /// @notice Schedule a UUPS upgrade, requiring Director + Commissioner EIP-712 signatures.
    /// @dev    The upgrade cannot be executed until UPGRADE_TIMELOCK (48 h) has elapsed,
    ///         giving a regulatory notification window as required by OJK / MoM 27 Feb 2026.
    /// @param newImplementation  Address of the new implementation contract.
    /// @param operationIdentifier Unique off-chain reference for audit trail.
    /// @param deadline           Unix timestamp after which signatures expire.
    /// @param signatures         EIP-712 signatures from Director and Commissioner.
    function scheduleUpgrade(
        address newImplementation,
        string calldata operationIdentifier,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        address caller = msg.sender;
        uint256 ts = block.timestamp;
        require(
            hasRole(ADMIN_ROLE, caller) ||
                hasRole(DIRECTOR_ROLE, caller) ||
                hasRole(COMMISSIONER_ROLE, caller),
            "Caller does not have the required role"
        );
        require(newImplementation != address(0), "Invalid implementation address");
        require(ts <= deadline, "Operation expired");
        require(deadline <= ts + MAX_DEADLINE_WINDOW, "Deadline exceeds maximum");
        require(
            pendingUpgrade.newImplementation == address(0),
            "Upgrade already pending"
        );

        bytes32 upgradeHash = getUpgradeHash(
            newImplementation,
            operationIdentifier,
            deadline
        );
        require(!usedSignatures[upgradeHash], "Operation hash already used");

        _verifyUpgradeSignatures(upgradeHash, signatures);

        usedSignatures[upgradeHash] = true;

        pendingUpgrade = PendingUpgrade({
            newImplementation: newImplementation,
            scheduledAt: ts,
            operationIdentifier: operationIdentifier
        });

        emit UpgradeScheduled(
            newImplementation,
            ts,
            ts + UPGRADE_TIMELOCK,
            operationIdentifier
        );
    }

    /// @notice Cancel a pending upgrade. Only ADMIN_ROLE may cancel.
    function cancelUpgrade() external onlyRole(ADMIN_ROLE) {
        require(
            pendingUpgrade.newImplementation != address(0),
            "No pending upgrade"
        );
        address impl = pendingUpgrade.newImplementation;
        string memory opId = pendingUpgrade.operationIdentifier;
        delete pendingUpgrade;
        emit UpgradeCancelled(impl, opId);
    }

    /// @notice Returns the EIP-712 hash to be signed for a scheduled upgrade.
    function getUpgradeHash(
        address newImplementation,
        string calldata operationIdentifier,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                UPGRADE_TYPEHASH,
                newImplementation,
                keccak256(bytes(operationIdentifier)),
                deadline
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
            );
    }

    /// @dev Require at least one Director signature AND at least one Commissioner signature.
    ///      Each signer may satisfy at most one role (duplicate signer addresses are rejected).
    function _verifyUpgradeSignatures(
        bytes32 upgradeHash,
        bytes[] calldata signatures
    ) internal view {
        address[] memory signers = _recoverUniqueSigners(upgradeHash, signatures);
        uint256 sigLen = signers.length;

        bool hasDirector;
        bool hasCommissioner;

        for (uint256 i = 0; i < sigLen; ) {
            address s = signers[i];
            if (!hasDirector && hasRole(DIRECTOR_ROLE, s)) {
                hasDirector = true;
                signers[i] = address(1);
            } else if (!hasCommissioner && hasRole(COMMISSIONER_ROLE, s)) {
                hasCommissioner = true;
                signers[i] = address(1);
            }
            if (hasDirector && hasCommissioner) break; // early exit
            unchecked { ++i; }
        }

        require(
            hasDirector && hasCommissioner,
            "Upgrade requires Director + Commissioner signatures"
        );
    }

    /// @dev Called by UUPSUpgradeable.upgradeToAndCall.
    ///      Enforces that the upgrade was scheduled via scheduleUpgrade and the
    ///      48-hour timelock has fully elapsed.
    function _authorizeUpgrade(
        address newImplementation
    ) internal override {
        require(
            pendingUpgrade.newImplementation == newImplementation,
            "Implementation not scheduled for upgrade"
        );
        require(
            block.timestamp >= pendingUpgrade.scheduledAt + UPGRADE_TIMELOCK,
            "Upgrade timelock not elapsed"
        );

        string memory opId = pendingUpgrade.operationIdentifier;
        delete pendingUpgrade;

        emit UpgradeExecuted(newImplementation, opId);
    }
}

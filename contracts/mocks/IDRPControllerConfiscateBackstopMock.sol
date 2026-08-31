// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../IDRPController.sol";

/// @dev Test-only harness. `_validateQuorumRules` now rejects a multi-tier
/// Confiscate rule set at every real write path (setQuorumRules,
/// scheduleQuorumRules), so the execute-time assert in `executeOperation` is
/// otherwise unreachable through the public ABI. This mock writes
/// `quorumRules` directly — bypassing validation entirely, the way a future
/// write path might if it forgot to validate — so the backstop can be
/// exercised and proven live, not dead code.
contract IDRPControllerConfiscateBackstopMock is IDRPController {
    function seedQuorumRulesRaw(
        OperationType operationType,
        QuorumRule[] calldata rules
    ) external {
        delete quorumRules[operationType];
        for (uint256 i = 0; i < rules.length; i++) {
            quorumRules[operationType].push(rules[i]);
        }
    }
}

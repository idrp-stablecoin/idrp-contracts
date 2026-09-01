// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IDRPController} from "../IDRPController.sol";

/**
 * @title  IDRPControllerNileRepair
 * @notice TRON NILE TESTNET ONLY. Do not deploy, schedule, or reference on mainnet.
 *
 * @dev    The Nile Controller proxy was recovered by calling `initialize()` while it ran
 *         an implementation built WITHOUT the 251-slot legacy gap. That wrote `idrpToken`
 *         into slot 0 — the slot OpenZeppelin 4.x uses for `Initializable._initialized`
 *         and `_initializing`. Read as OZ4, slot 0 now yields `_initialized = 237` and a
 *         truthy `_initializing`, so every OZ4 initializer and reinitializer is blocked
 *         on that proxy forever.
 *
 *         This contract is the normal Controller plus one extra function that restores
 *         slot 0 to `1` — "initialized at version 1, not currently initializing" — which
 *         is what a healthy OZ4 proxy holds, and what both Tron mainnet proxies still
 *         have today.
 *
 *         Deliberately minimal and boring:
 *         - it inherits IDRPController, so the storage layout and every access-control
 *           rule are identical to the real implementation;
 *         - the repair is gated by the same `onlyUpgrader` modifier as the rest;
 *         - upgrades into and out of it still go through `scheduleUpgrade` and the
 *           timelock — nothing here bypasses either;
 *         - slot 0 sits inside `__legacyStorageGap`, so no live variable is touched.
 *
 *         Intended sequence on Nile:
 *           1. scheduleUpgrade(this) -> wait the timelock -> upgradeToAndCall(this, "")
 *           2. repairLegacyInitSlot()
 *           3. scheduleUpgrade(<real impl>) -> wait -> upgradeToAndCall(<real impl>, initializeV3(...))
 *
 *         After step 3 this contract is no longer referenced by the proxy.
 */
contract IDRPControllerNileRepair is IDRPController {
    event LegacyInitSlotRepaired(uint256 oldValue, uint256 newValue);

    /// @notice Restore the legacy OZ4 `Initializable` slot to `initialized = 1`.
    /// @dev Writes slot 0 only. That slot is inside `__legacyStorageGap` and is not read
    ///      by this implementation; it matters only to an OpenZeppelin 4.x implementation.
    function repairLegacyInitSlot() external onlyUpgrader {
        uint256 previous;
        assembly {
            previous := sload(0)
            sstore(0, 1)
        }
        emit LegacyInitSlotRepaired(previous, 1);
    }

    /// @notice Current value of the legacy slot, for verification before and after.
    function legacyInitSlot() external view returns (uint256 value) {
        assembly {
            value := sload(0)
        }
    }
}

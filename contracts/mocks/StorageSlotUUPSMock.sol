// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TronUUPSUpgradeable} from "../utils/TronUUPSUpgradeable.sol";

/**
 * @title  StorageSlotUUPSMock
 * @notice TEST FIXTURE ONLY. Never deploy this.
 *
 * @dev    Minimal implementation built on `TronUUPSUpgradeable`, which keeps the proxy
 *         address in storage instead of using OpenZeppelin's `immutable __self`.
 *
 *         It exists so the regression test can demonstrate — permanently, in CI — why
 *         production contracts must NOT use that base. Upgrading a proxy INTO this
 *         implementation succeeds, because the previous implementation performs the
 *         upgrade and never consults the slot. Every upgrade afterwards reverts
 *         `TronUUPSUnauthorizedCallContext`, because the slot is written only from an
 *         initializer and a pre-existing proxy never ran one. The proxy is then frozen
 *         on this implementation permanently.
 *
 *         That is exactly what happened to the Tron Nile Controller on 2026-09-02, and
 *         both Tron mainnet proxies read zero in the same slot, so they were one upgrade
 *         away from the same fate.
 *
 *         `_authorizeUpgrade` is intentionally unguarded: the point of the fixture is the
 *         proxy-context check, not access control.
 */
contract StorageSlotUUPSMock is TronUUPSUpgradeable {
    uint256 public constant UPGRADE_DELAY = 5 minutes;

    function initialize() external initializer {
        __UUPSUpgradeable_init();
    }

    /// @dev No-op so the test can drive the same call sequence as the real Controller.
    function scheduleUpgrade(address) external {}

    function _authorizeUpgrade(address) internal override {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDRP} from "../IDRP.sol";

/**
 * Probe: what does the NEXT appended storage variable read on a chain that ran
 * the retired confiscation-wallet design?
 *
 * Inheriting IDRP places `nextFeatureSlot` immediately after IDRP's own storage.
 * On a proxy whose retired slot was never cleared, that is the slot the old
 * `confiscationWallet` occupied — so this reads whatever is still sitting there.
 *
 * Test-only. Never deploy.
 */
contract IDRPNextVarProbeMock is IDRP {
    /// @dev The first slot a future feature would claim.
    address public nextFeatureSlot;
}

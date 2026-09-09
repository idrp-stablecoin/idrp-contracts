// SPDX-License-Identifier: MIT
// LAYOUT PROBE — "does the NEXT upgrade still work?"
// Two variants, each adding one ordinary new variable the way a future feature
// would, so the validator can be asked directly instead of reasoned about.
// Test-only. Never deploy.
pragma solidity ^0.8.28;

import {IDRP} from "../IDRP.sol";
import {IDRPWithRetiredSlots} from "../legacy/IDRPWithRetiredSlots.sol";

/// A future feature appended to the PLACEHOLDER variant — lands on slot 12.
contract IDRPPlaceholderPlusFeature is IDRPWithRetiredSlots {
    address public someFutureWallet;
}

/// A future feature appended to the CLEAN variant — lands on slot 9.
contract IDRPCleanPlusFeature is IDRP {
    address public someFutureWallet;
}

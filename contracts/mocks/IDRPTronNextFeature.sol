// SPDX-License-Identifier: MIT
// LAYOUT PROBE — where does the NEXT feature's storage land on the Tron lineage?
// Test-only. Never deploy.
pragma solidity ^0.8.22;

import {IDRP} from "../IDRP.sol";
import {IDRPController} from "../IDRPController.sol";

contract IDRPTronNextFeature is IDRP {
    address public someFutureWallet;
}

contract IDRPControllerTronNextFeature is IDRPController {
    uint256 public someFutureSetting;
}

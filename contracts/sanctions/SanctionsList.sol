// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SanctionsList — IDRP's clone of the Chainalysis sanctions oracle.
/// @notice Functionally identical to the on-chain Chainalysis SanctionsList
///         contract (mainnet 0x40C57923924B5c5c5455c48D93317139ADDaC8fb): same
///         function signatures, same events, same storage shape, same name
///         string. Deploy this on chains Chainalysis does not yet support
///         (Kaia, Tron) so consumers built against the Chainalysis ABI work
///         unchanged. When Chainalysis ships natively on Kaia/Tron, swap the
///         consumer's pointer to their address — no other change needed.
///
///         Differences from the verbatim Chainalysis source (cosmetic only):
///           - pragma bumped from 0.8.7 to ^0.8.20 to fit IDRP's Tron toolchain
///         The on-chain interface a caller sees is identical.
contract SanctionsList is Ownable {
    mapping(address => bool) private sanctionedAddresses;

    event SanctionedAddress(address indexed addr);
    event NonSanctionedAddress(address indexed addr);
    event SanctionedAddressesAdded(address[] addrs);
    event SanctionedAddressesRemoved(address[] addrs);

    // OZ v4 Ownable: default constructor sets _owner = _msgSender() automatically.
    // No explicit constructor needed — leaving one in place would require calling
    // Ownable() with no args (v4 signature) instead of Ownable(initialOwner) (v5).

    function name() external pure returns (string memory) {
        return "Chainalysis sanctions oracle";
    }

    function addToSanctionsList(address[] memory newSanctions) public onlyOwner {
        for (uint256 i = 0; i < newSanctions.length; i++) {
            sanctionedAddresses[newSanctions[i]] = true;
        }
        emit SanctionedAddressesAdded(newSanctions);
    }

    function removeFromSanctionsList(address[] memory removeSanctions) public onlyOwner {
        for (uint256 i = 0; i < removeSanctions.length; i++) {
            sanctionedAddresses[removeSanctions[i]] = false;
        }
        emit SanctionedAddressesRemoved(removeSanctions);
    }

    function isSanctioned(address addr) public view returns (bool) {
        return sanctionedAddresses[addr] == true;
    }

    /// @notice Like `isSanctioned` but emits an event with the result.
    /// @dev Non-view by design — emits SanctionedAddress / NonSanctionedAddress
    ///      so off-chain monitors can subscribe to lookups. Behavior matches
    ///      Chainalysis verbatim.
    function isSanctionedVerbose(address addr) public returns (bool) {
        if (isSanctioned(addr)) {
            emit SanctionedAddress(addr);
            return true;
        } else {
            emit NonSanctionedAddress(addr);
            return false;
        }
    }
}
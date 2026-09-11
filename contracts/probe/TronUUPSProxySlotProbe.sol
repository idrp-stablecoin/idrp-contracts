// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title  TronUUPSProxySlotProbe
 * @notice Throwaway diagnostic. NOT part of the protocol. Do not deploy to mainnet.
 *
 * @dev    Reproduces, on the real TVM, the exact storage state of a Tron proxy whose
 *         TronUUPS proxy slot was never written, so that one question can be answered
 *         by measurement instead of inference:
 *
 *           Does the deployed implementation's initializeV3 write that slot?
 *
 *         It matters because initializeV3 is reinitializer(3) and the live proxy sits
 *         at _initialized == 1, so it can be called exactly once. If it does write the
 *         slot, calling it restores upgradeability. If it does not, calling it consumes
 *         the only remaining reinitializer and the proxy can never be upgraded again.
 *
 *         The implementation is reached by delegatecall from this contract, so
 *         address(this) and the storage it sees are the same as under the real proxy.
 *         The constructor writes the relevant words verbatim from the live proxy:
 *         _initialized = 1, the upgrader, the ERC-1967 implementation pointer, and the
 *         TronUUPS slot left at zero. Storage is then read back with eth_getStorageAt.
 */
contract TronUUPSProxySlotProbe {
    /// Live Nile Controller implementation, reused as-is — the code under test.
    address internal constant IMPL = 0x95c9eEd985536228D4a220D1357F2f20Cf8709D2;
    /// Caller that must pass the implementation's onlyUpgrader guard.
    address internal constant UPGRADER = 0xe8F4b8D44D9385C547aA95Cb249Ac35B254625d7;

    bytes32 internal constant ERC1967_IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor() {
        assembly {
            sstore(0, 1) // Initializable: _initialized = 1, _initializing = false
            sstore(258, UPGRADER) // `upgrader` in the post-port layout
            sstore(7, UPGRADER) // and in the pre-port layout, which the live proxy also carries
            sstore(ERC1967_IMPL_SLOT, IMPL)
            // keccak256("idrp.tron.uups.__proxy") is deliberately left at zero.
        }
    }

    // solhint-disable-next-line no-complex-fallback
    fallback() external payable {
        assembly {
            let impl := sload(ERC1967_IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { OFTAdapterUpgradeable } from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTAdapterUpgradeable.sol";
import { MessagingFee } from "@layerzerolabs/oft-evm/contracts/OFTCore.sol";

interface IIDRP {
    function frozen(address account) external view returns (bool);
    function paused() external view returns (bool);
}

contract IDRPOFTAdapterUpgradeable is OFTAdapterUpgradeable {
    // Message types for compliance
    uint8 public constant MSG_FREEZE = 1;
    uint8 public constant MSG_UNFREEZE = 2;
    uint8 public constant MSG_PAUSE = 3;
    uint8 public constant MSG_UNPAUSE = 4;

    event Broadcast(uint32 indexed dstEid, uint8 msgType, address account);

    error InvalidMessageType();
    error StateNotMatching();

    constructor(address _token, address _lzEndpoint) OFTAdapterUpgradeable(_token, _lzEndpoint) {
        _disableInitializers();
    }

    function initialize(address _delegate) public initializer {
        __OFTAdapter_init(_delegate);
        __Ownable_init(_delegate);
    }

    /// @notice Broadcast compliance state to remote chains
    /// @param msgType Message type (1=freeze, 2=unfreeze, 3=pause, 4=unpause)
    /// @param account Account address (use address(0) for pause/unpause)
    /// @param dstEids Array of destination chain EIDs
    function broadcast(uint8 msgType, address account, uint32[] calldata dstEids) external payable {
        _verifyState(msgType, account);
        _broadcast(msgType, account, dstEids);
    }

    /// @notice Quote fee for broadcasting (returns native token amount in wei)
    /// @param msgType Message type (1=freeze, 2=unfreeze, 3=pause, 4=unpause)
    /// @param account Account address (use address(0) for pause/unpause)
    /// @param dstEids Array of destination chain EIDs
    function quoteBroadcast(
        uint8 msgType,
        address account,
        uint32[] calldata dstEids
    ) external view returns (uint256 total) {
        bytes memory payload = abi.encodePacked(msgType, account);
        for (uint256 i = 0; i < dstEids.length; i++) {
            require(peers(dstEids[i]) != bytes32(0), "No peer");
            MessagingFee memory fee = _quote(dstEids[i], payload, "", false);
            total += fee.nativeFee;
        }
    }

    function _verifyState(uint8 msgType, address account) internal view {
        IIDRP idrp = IIDRP(address(innerToken));

        if (msgType == MSG_FREEZE) {
            if (!idrp.frozen(account)) revert StateNotMatching();
        } else if (msgType == MSG_UNFREEZE) {
            if (idrp.frozen(account)) revert StateNotMatching();
        } else if (msgType == MSG_PAUSE) {
            if (!idrp.paused()) revert StateNotMatching();
        } else if (msgType == MSG_UNPAUSE) {
            if (idrp.paused()) revert StateNotMatching();
        } else {
            revert InvalidMessageType();
        }
    }

    function _broadcast(uint8 msgType, address account, uint32[] calldata dstEids) internal {
        require(dstEids.length > 0, "No destinations");
        bytes memory payload = abi.encodePacked(msgType, account);
        uint256 feePerChain = msg.value / dstEids.length;

        for (uint256 i = 0; i < dstEids.length; i++) {
            require(peers(dstEids[i]) != bytes32(0), "No peer");
            _lzSend(dstEids[i], payload, "", MessagingFee(feePerChain, 0), payable(msg.sender));
            emit Broadcast(dstEids[i], msgType, account);
        }
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { OFTUpgradeable } from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTUpgradeable.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

contract IDRPOFTUpgradeable is OFTUpgradeable {
    // Compliance state
    mapping(address => bool) public frozen;
    bool public paused;

    // Message types
    uint8 public constant MSG_FREEZE = 1;
    uint8 public constant MSG_UNFREEZE = 2;
    uint8 public constant MSG_PAUSE = 3;
    uint8 public constant MSG_UNPAUSE = 4;

    // Events
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event Paused();
    event Unpaused();

    constructor(address _lzEndpoint) OFTUpgradeable(_lzEndpoint) {
        _disableInitializers();
    }

    function initialize(string memory _name, string memory _symbol, address _delegate) public initializer {
        __OFT_init(_name, _symbol, _delegate);
        __Ownable_init(_delegate);
    }

    /**
     * @dev Returns 6 decimals to match IDRP token on canonical chain.
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) internal virtual override {
        // Short message = compliance update (msgType + address = 21 bytes)
        if (_message.length == 21) {
            uint8 msgType = uint8(_message[0]);

            if (msgType == MSG_FREEZE) {
                address account = address(bytes20(_message[1:21]));
                frozen[account] = true;
                emit AccountFrozen(account);
                return;
            } else if (msgType == MSG_UNFREEZE) {
                address account = address(bytes20(_message[1:21]));
                frozen[account] = false;
                emit AccountUnfrozen(account);
                return;
            } else if (msgType == MSG_PAUSE) {
                paused = true;
                emit Paused();
                return;
            } else if (msgType == MSG_UNPAUSE) {
                paused = false;
                emit Unpaused();
                return;
            }
        }

        // Standard OFT message (token transfer)
        super._lzReceive(_origin, _guid, _message, _executor, _extraData);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!paused, "IDRP: paused");
        require(!frozen[from], "IDRP: sender frozen");
        require(!frozen[to], "IDRP: recipient frozen");
        super._update(from, to, value);
    }
}

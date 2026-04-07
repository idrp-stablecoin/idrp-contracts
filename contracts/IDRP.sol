// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.22;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract IDRP is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Mapping to track frozen accounts
    mapping(address => bool) public frozen;

    address public depositoryWallet;
    uint256 public maxSupply;

    // Role addresses
    address public admin;
    address public controller;

    /// @dev Events
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event DepositoryWalletUpdated(
        address indexed oldWallet,
        address indexed newWallet
    );
    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event ControllerUpdated(
        address indexed oldController,
        address indexed newController
    );

    /// @dev Errors
    error FrozenAccount();
    error NotAdmin();
    error NotController();
    error ControllerNotSet();

    /// @dev Modifiers
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyController() {
        if (controller == address(0)) revert ControllerNotSet();
        if (msg.sender != controller) revert NotController();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _admin) public initializer {
        __ERC20_init("IDRP", "IDRP");
        __ERC20Pausable_init();
        __ERC20Permit_init("IDRP");
        __UUPSUpgradeable_init();

        admin = _admin;
    }

    /// @notice Migrate from AccessControl to explicit roles (upgrade-only)
    function initializeV2(
        address _admin,
        address _controller
    ) public reinitializer(2) {
        admin = _admin;
        controller = _controller;
    }

    /// @notice Set admin address
    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "Invalid address");
        address old = admin;
        admin = _admin;
        emit AdminUpdated(old, _admin);
    }

    /// @notice Set controller (IDRPController) address
    function setController(address _controller) external onlyAdmin {
        require(_controller != address(0), "Invalid address");
        address old = controller;
        controller = _controller;
        emit ControllerUpdated(old, _controller);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function pause() public onlyController {
        _pause();
    }

    function unpause() public onlyController {
        _unpause();
    }

    /// @notice Mint stablecoins to depository wallet
    /// @param amount The amount of stablecoins to mint
    function mint(uint256 amount) public onlyController whenNotPaused {
        require(
            depositoryWallet != address(0),
            "Depository wallet not set"
        );
        if (frozen[depositoryWallet]) revert FrozenAccount();
        require(
            maxSupply == 0 || totalSupply() + amount <= maxSupply,
            "Exceeds max supply"
        );
        _mint(depositoryWallet, amount);
    }

    /// @notice Set the maximum supply cap
    /// @param _maxSupply The max supply (0 = unlimited)
    function setMaxSupply(
        uint256 _maxSupply
    ) external onlyAdmin {
        uint256 oldMaxSupply = maxSupply;
        maxSupply = _maxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, _maxSupply);
    }

    /// @notice Burn stablecoins from a specific address
    /// @param from The address from which the stablecoins will be burned
    /// @param amount The amount of stablecoins to burn
    /// @dev If `from` is the IDRPController (caller), no allowance check is needed
    /// since the user has already transferred tokens to the controller.
    /// If `from` is another address, allowance check is required.
    function burn(
        address from,
        uint256 amount
    ) public onlyController whenNotPaused {
        if (frozen[from]) revert FrozenAccount();

        // If `from` is not the caller (controller) and not depositoryWallet,
        // ensure the caller has allowance from 'from'
        // - depositoryWallet is a cold wallet and can't approve
        // - controller transfers tokens to itself before burning, so no allowance needed
        if (from != _msgSender() && from != depositoryWallet) {
            uint256 currentAllowance = allowance(from, _msgSender());
            require(
                currentAllowance >= amount,
                "Burn amount exceeds allowance"
            );
            _approve(from, _msgSender(), currentAllowance - amount);
        }

        _burn(from, amount);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyAdmin {}

    /// @notice Freeze an account, preventing transfers
    /// @param account The address to freeze
    function freeze(address account) external onlyController {
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    /// @notice Unfreeze an account, allowing transfers
    /// @param account The address to unfreeze
    function unfreeze(address account) external onlyController {
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    /// @notice Set the depository wallet address
    /// @param wallet The address of the depository wallet
    function setDepositoryWallet(
        address wallet
    ) external onlyAdmin {
        require(wallet != address(0), "Invalid wallet address");
        address oldWallet = depositoryWallet;
        depositoryWallet = wallet;
        emit DepositoryWalletUpdated(oldWallet, wallet);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Freeze check for regular transfers (not mint/burn)
        if (from != address(0) && to != address(0)) {
            if (frozen[from] || frozen[to]) revert FrozenAccount();
            require(value > 0, "Transfer amount must be greater than zero");
        }
        super._update(from, to, value);
    }

    // Function to withdraw other tokens that might be sent to this contract
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyAdmin {
        require(token != address(this), "Cannot withdraw IDRP token");
        IERC20(token).safeTransfer(to, amount);
    }
}

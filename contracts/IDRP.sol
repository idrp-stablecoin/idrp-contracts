// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.22;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {TronUUPSUpgradeable} from "./utils/TronUUPSUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract IDRP is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    AccessControlUpgradeable,
    ERC20PermitUpgradeable,
    TronUUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // Mapping to track frozen accounts
    mapping(address => bool) public frozen;

    address public depositoryWallet;

    /// @notice Maximum token supply enforcing the 1:1 Rupiah reserve peg.
    /// @dev    0 means uncapped (only valid before admin calls setMaxSupply for the first time).
    ///         Once set it can only be raised or lowered by DEFAULT_ADMIN_ROLE.
    uint256 public maxSupply;

    /// @dev Events
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event DepositoryWalletSet(address indexed previousWallet, address indexed newWallet);
    event MaxSupplyUpdated(uint256 indexed previousMaxSupply, uint256 indexed newMaxSupply);

    /// @dev Errors
    error FrozenAccount();
    error ExceedsMaxSupply(uint256 requested, uint256 available);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address superAdmin) public initializer {
        __ERC20_init("IDRP", "IDRP");
        __ERC20Pausable_init();
        __AccessControl_init();
        __ERC20Permit_init("IDRP");
        __TronUUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, superAdmin);
        _grantRole(PAUSER_ROLE, superAdmin);
        _grantRole(MINTER_ROLE, superAdmin);
        _grantRole(FREEZER_ROLE, superAdmin);
        _grantRole(UPGRADER_ROLE, superAdmin);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Mint stablecoins to a specific address
    /// @param amount The amount of stablecoins to mint
    function mint(uint256 amount) public onlyRole(MINTER_ROLE) whenNotPaused {
        // Cache storage reads — each SLOAD costs 100 energy on Tron (warm) / 2100 (cold)
        address wallet = depositoryWallet;
        require(wallet != address(0), "Depository wallet not set");
        if (frozen[wallet]) revert FrozenAccount();
        if (maxSupply != 0) {
            uint256 available = maxSupply - totalSupply();
            if (amount > available) revert ExceedsMaxSupply(amount, available);
        }
        _mint(wallet, amount);
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
    ) public onlyRole(MINTER_ROLE) whenNotPaused {
        if (frozen[from]) revert FrozenAccount();

        // Cache _msgSender() — avoids a repeated virtual call
        address caller = _msgSender();
        if (from != caller && from != depositoryWallet) {
            uint256 currentAllowance = allowance(from, caller);
            require(
                currentAllowance >= amount,
                "Burn amount exceeds allowance"
            );
            _approve(from, caller, currentAllowance - amount);
        }

        _burn(from, amount);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    /// @notice Freeze an account, preventing transfers
    /// @param account The address to freeze
    function freeze(address account) external onlyRole(FREEZER_ROLE) {
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    /// @notice Unfreeze an account, allowing transfers
    /// @param account The address to unfreeze
    function unfreeze(address account) external onlyRole(FREEZER_ROLE) {
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    /// @notice Set the depository wallet address
    /// @param wallet The address of the depository wallet
    function setDepositoryWallet(
        address wallet
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(wallet != address(0), "Invalid wallet address");
        address previous = depositoryWallet;
        depositoryWallet = wallet;
        emit DepositoryWalletSet(previous, wallet);
    }

    /// @notice Set the maximum token supply cap (on-chain 1:1 peg safety net).
    /// @dev    newMax must be >= current totalSupply() to avoid making existing
    ///         circulating supply invalid. Set to 0 to remove the cap (not recommended
    ///         in production — only during initial bootstrap before reserves are set).
    /// @param newMax New maximum supply in token base units (6 decimals).
    function setMaxSupply(uint256 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            newMax == 0 || newMax >= totalSupply(),
            "Max supply below current total supply"
        );
        uint256 previous = maxSupply;
        maxSupply = newMax;
        emit MaxSupplyUpdated(previous, newMax);
    }

    /// @dev Central hook for all token movements (mint, burn, transfer).
    /// ERC20PausableUpgradeable._update enforces whenNotPaused.
    /// Freeze checks are enforced here for every transfer path.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        if (from != address(0) && frozen[from]) revert FrozenAccount();
        if (to != address(0) && frozen[to]) revert FrozenAccount();
        super._update(from, to, value);
    }

    // Function to withdraw other tokens that might be sent to this contract
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(this), "Cannot withdraw IDRP token");
        require(to != address(0), "Invalid recipient address");
        IERC20(token).safeTransfer(to, amount);
    }
}

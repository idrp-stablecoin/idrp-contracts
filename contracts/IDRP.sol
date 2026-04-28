// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// OZ v4 import paths (berbeda dari v5)
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./utils/TronUUPSUpgradeable.sol";

contract IDRP is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    AccessControlUpgradeable,
    ERC20PermitUpgradeable,
    TronUUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 public constant FREEZER_ROLE  = keccak256("FREEZER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    mapping(address => bool) public frozen;

    // OZ v4: custom errors tetap bisa dipakai
    error FrozenAccount();
    error ExceedsMaxSupply(uint256 requested, uint256 available);
    error InvalidAddress();

    uint256 public maxSupply;
    address public depositoryWallet;

    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event MaxSupplyUpdated(uint256 indexed previousMaxSupply, uint256 indexed newMaxSupply);
    event DepositoryWalletSet(address indexed previousWallet, address indexed newWallet);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address superAdmin) public initializer {
        __ERC20_init("IDRP", "IDRP");
        __ERC20Pausable_init();
        __AccessControl_init();
        __ERC20Permit_init("IDRP");
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, superAdmin);
        _grantRole(PAUSER_ROLE, superAdmin);
        _grantRole(MINTER_ROLE, superAdmin);
        _grantRole(FREEZER_ROLE, superAdmin);
        _grantRole(UPGRADER_ROLE, superAdmin);
    }

    // OZ v4: Ownable tidak pakai argument di constructor
    // _authorizeUpgrade hanya perlu onlyRole
    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}

    function mint(uint256 amount) public onlyRole(MINTER_ROLE) whenNotPaused {
        if (maxSupply > 0 && totalSupply() + amount > maxSupply) {
            revert ExceedsMaxSupply(amount, maxSupply - totalSupply());
        }
        _mint(depositoryWallet, amount);
    }

    function burn(address from, uint256 amount) public onlyRole(MINTER_ROLE) whenNotPaused {
        _burn(from, amount);
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function freeze(address account) public onlyRole(FREEZER_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    function unfreeze(address account) public onlyRole(FREEZER_ROLE) {
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    function setDepositoryWallet(address wallet) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(wallet != address(0), "Invalid wallet address");
        address prev = depositoryWallet;
        depositoryWallet = wallet;
        emit DepositoryWalletSet(prev, wallet);
    }

    function setMaxSupply(uint256 newMax) public onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 prev = maxSupply;
        maxSupply = newMax;
        emit MaxSupplyUpdated(prev, newMax);
    }

    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) public onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }

    // OZ v4: _beforeTokenTransfer bukan _update
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        if (frozen[from]) revert FrozenAccount();
        if (to != address(0) && frozen[to]) revert FrozenAccount();
        super._beforeTokenTransfer(from, to, amount);
    }
}
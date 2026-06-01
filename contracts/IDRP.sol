// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.22;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal interface IDRP needs from a sanctions list. Matches the
///         Chainalysis SanctionsList ABI exactly so we can point at theirs on
///         chains they support, and at our own clone on Kaia.
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

contract IDRP is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    AccessControlUpgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");

    // Mapping to track frozen accounts
    mapping(address => bool) public frozen;

    address public depositoryWallet;
    uint256 public maxSupply;

    // Single-address upgrader
    address public upgrader;

    // Upgrade timelock
    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;

    /// @notice Optional external sanctions list (Chainalysis SanctionsList ABI).
    ///         When zero, no on-chain enforcement (advisory mode). When set,
    ///         every non-mint, non-burn transfer pays one STATICCALL per side.
    ///         Appended at the end of storage on purpose — UUPS layout safe.
    address public sanctionsList;

    /// @dev Events
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event DepositoryWalletUpdated(
        address indexed oldWallet,
        address indexed newWallet
    );
    event UpgraderUpdated(
        address indexed oldUpgrader,
        address indexed newUpgrader
    );
    event UpgradeScheduled(
        address indexed newImplementation,
        uint256 executableAfter
    );
    event UpgradeCancelled(
        address indexed newImplementation,
        address indexed cancelledBy
    );
    event SanctionsListUpdated(
        address indexed previousList,
        address indexed newList
    );

    /// @dev Errors
    error FrozenAccount();
    error NotUpgrader();
    error SanctionedSender(address sender);
    error SanctionedRecipient(address recipient);

    /// @dev Modifiers
    modifier onlyUpgrader() {
        if (_msgSender() != upgrader) revert NotUpgrader();
        _;
    }

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

        upgrader = superAdmin;
        emit UpgraderUpdated(address(0), superAdmin);
    }

    /// @notice One-time migration for proxies originally deployed with UPGRADER_ROLE.
    /// @dev Sets the single `upgrader` and revokes the legacy role from historical
    ///      grantees so stale state does not re-grant authority if the role is ever
    ///      reintroduced with the same string ("UPGRADER_ROLE") in a future upgrade.
    ///      Plain AccessControlUpgradeable cannot enumerate holders on-chain, so the
    ///      caller must pass the per-chain list obtained by replaying RoleGranted /
    ///      RoleRevoked events (see scripts/list-upgrader-holders.ts).
    ///      Gated by DEFAULT_ADMIN_ROLE so an attacker cannot frontrun the post-upgrade
    ///      migration tx and seize `upgrader`.
    /// @param _upgrader New single-address upgrader (e.g. Safe).
    /// @param _legacyUpgraderHolders Addresses that ever held UPGRADER_ROLE on this chain.
    function initializeV2(
        address _upgrader,
        address[] calldata _legacyUpgraderHolders
    ) external reinitializer(2) onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_upgrader != address(0), "Invalid upgrader");

        address oldUpgrader = upgrader;
        upgrader = _upgrader;
        emit UpgraderUpdated(oldUpgrader, _upgrader);

        bytes32 legacyUpgraderRole = keccak256("UPGRADER_ROLE");
        for (uint256 i = 0; i < _legacyUpgraderHolders.length; i++) {
            _revokeRole(legacyUpgraderRole, _legacyUpgraderHolders[i]);
        }
    }

    /// @notice Rotate the single upgrader address. Only DEFAULT_ADMIN_ROLE (Safe) may rotate.
    function setUpgrader(address _upgrader) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_upgrader != address(0), "Invalid upgrader");
        address oldUpgrader = upgrader;
        upgrader = _upgrader;
        emit UpgraderUpdated(oldUpgrader, _upgrader);
    }

    /// @notice Schedule a UUPS upgrade. Starts the 48h timelock window.
    /// @dev Only the single-address `upgrader` may schedule. The proxy cannot
    ///      upgrade to any implementation other than the one scheduled here.
    function scheduleUpgrade(address newImplementation) external onlyUpgrader {
        require(
            newImplementation != address(0),
            "Invalid implementation address"
        );
        scheduledImplementation = newImplementation;
        upgradeScheduledAt = block.timestamp;
        emit UpgradeScheduled(
            newImplementation,
            block.timestamp + UPGRADE_DELAY
        );
    }

    /// @notice Cancel a pending scheduled upgrade.
    function cancelUpgrade() external onlyUpgrader {
        address cancelled = scheduledImplementation;
        require(cancelled != address(0), "No pending upgrade");
        scheduledImplementation = address(0);
        upgradeScheduledAt = 0;
        emit UpgradeCancelled(cancelled, _msgSender());
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
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
    ) public onlyRole(MINTER_ROLE) whenNotPaused {
        if (frozen[from]) revert FrozenAccount();

        // If `from` is not the caller (MINTER_ROLE/IDRPController) and not depositoryWallet,
        // ensure the caller has allowance from 'from'
        // - depositoryWallet is a cold wallet and can't approve
        // - controller transfers tokens to itself before burning, so no allowance needed
        if (from != _msgSender() && from != depositoryWallet) {
            // Ensure the MINTER_ROLE has an allowance from 'from'
            uint256 currentAllowance = allowance(from, _msgSender());
            require(
                currentAllowance >= amount,
                "Burn amount exceeds allowance"
            );
            // Deduct the burned amount from the allowance
            _approve(from, _msgSender(), currentAllowance - amount);
        }

        _burn(from, amount);
    }

    // Enforces single-upgrader auth AND 48h timelock.
    // Clears scheduled state on execution so the slot can't be reused silently.
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyUpgrader {
        require(
            newImplementation == scheduledImplementation,
            "Upgrade not scheduled"
        );
        require(
            block.timestamp >= upgradeScheduledAt + UPGRADE_DELAY,
            "Timelock not expired"
        );
        scheduledImplementation = address(0);
        upgradeScheduledAt = 0;
    }

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
        require(wallet != depositoryWallet, "Same wallet");
        address oldWallet = depositoryWallet;
        depositoryWallet = wallet;
        emit DepositoryWalletUpdated(oldWallet, wallet);
    }

    /// @notice Point IDRP at a sanctions list (Chainalysis SanctionsList ABI).
    ///         Set to address(0) to disable on-chain enforcement (advisory only).
    /// @dev NOT behind the 48h timelock — by design. The point of pluggable
    ///      lists is fast swap (e.g. switch to Chainalysis when it lands on
    ///      Kaia) and a one-tx kill switch (`setSanctionsList(0)`) if a list
    ///      misbehaves. Multi-sig consensus is the gate.
    function setSanctionsList(
        address newList
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address prev = sanctionsList;
        sanctionsList = newList;
        emit SanctionsListUpdated(prev, newList);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Freeze + sanctions checks only on regular transfers (not mint/burn).
        if (from != address(0) && to != address(0)) {
            if (frozen[from] || frozen[to]) revert FrozenAccount();
            require(value > 0, "Transfer amount must be greater than zero");

            // Sanctions check fires only when a list is wired. Cached locally
            // so we pay one warm SLOAD instead of two when wired.
            address list = sanctionsList;
            if (list != address(0)) {
                if (ISanctionsList(list).isSanctioned(from)) {
                    revert SanctionedSender(from);
                }
                if (ISanctionsList(list).isSanctioned(to)) {
                    revert SanctionedRecipient(to);
                }
            }
        }
        super._update(from, to, value);
    }

    // Function to withdraw other tokens that might be sent to this contract
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(this), "Cannot withdraw IDRP token");
        IERC20(token).safeTransfer(to, amount);
    }
}

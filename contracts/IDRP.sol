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

/// @notice Minimal interface IDRP needs from a sanctions list. Matches the
///         Chainalysis SanctionsList ABI exactly so we can point at theirs on
///         chains they support, and at our own clone on Tron.
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

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
    // V1 had UPGRADER_ROLE; V2 replaces it with the single-address `upgrader`
    // slot below. Existing v1 proxies migrate via initializeV2() which revokes
    // the legacy role from historical grantees.

    mapping(address => bool) public frozen;

    // OZ v4: custom errors tetap bisa dipakai
    error FrozenAccount();
    error ExceedsMaxSupply(uint256 requested, uint256 available);
    error InvalidAddress();
    error NotUpgrader();
    error SanctionedSender(address sender);
    error SanctionedRecipient(address recipient);

    uint256 public maxSupply;
    address public depositoryWallet;

    // ─── V2 storage (appended — UUPS layout safe) ─────────────────────────────
    // Order matters: these slots must come AFTER the V1 layout (frozen,
    // maxSupply, depositoryWallet) so already-deployed v1 proxies preserve
    // their state on upgrade. New slots are zero-initialized; initializeV2()
    // populates `upgrader` for existing proxies.

    /// @notice Single-address upgrader (replaces UPGRADER_ROLE in V2).
    address public upgrader;

    /// @notice Upgrade timelock window (OJK / regulatory notification).
    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;

    /// @notice Optional external sanctions list (Chainalysis SanctionsList ABI).
    ///         When zero, no on-chain enforcement (advisory mode). When set,
    ///         every non-mint, non-burn transfer pays one STATICCALL per side.
    address public sanctionsList;

    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event MaxSupplyUpdated(uint256 indexed previousMaxSupply, uint256 indexed newMaxSupply);
    event DepositoryWalletSet(address indexed previousWallet, address indexed newWallet);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event UpgraderUpdated(address indexed oldUpgrader, address indexed newUpgrader);
    event UpgradeScheduled(address indexed newImplementation, uint256 executableAfter);
    event UpgradeCancelled(address indexed newImplementation, address indexed cancelledBy);
    event SanctionsListUpdated(address indexed previousList, address indexed newList);

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
        _grantRole(PAUSER_ROLE, superAdmin);
        _grantRole(MINTER_ROLE, superAdmin);
        _grantRole(FREEZER_ROLE, superAdmin);

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

    // OZ v4: Ownable tidak pakai argument di constructor
    // _authorizeUpgrade hanya perlu onlyRole
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // Enforces single-upgrader auth AND 48h timelock.
    // Clears scheduled state on execution so the slot can't be reused silently.
    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyUpgrader
    {
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

    function mint(uint256 amount) public onlyRole(MINTER_ROLE) whenNotPaused {
        address wallet = depositoryWallet; // cache: avoid 2 SLOADs
        require(wallet != address(0), "Depository wallet not set");
        if (frozen[wallet]) revert FrozenAccount();
        if (maxSupply > 0 && totalSupply() + amount > maxSupply) {
            revert ExceedsMaxSupply(amount, maxSupply - totalSupply());
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

        // If `from` is not the caller (MINTER_ROLE/IDRPController) and not depositoryWallet,
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
        if (account == address(0)) revert InvalidAddress();
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
        // 0 means unlimited; any non-zero cap must be >= current supply to avoid
        // underflow in mint()'s ExceedsMaxSupply error calculation.
        require(newMax == 0 || newMax >= totalSupply(), "Cannot reduce below current supply");
        uint256 prev = maxSupply;
        maxSupply = newMax;
        emit MaxSupplyUpdated(prev, newMax);
    }

    /// @notice Point IDRP at a sanctions list (Chainalysis SanctionsList ABI).
    ///         Set to address(0) to disable on-chain enforcement (advisory only).
    /// @dev NOT behind the 48h timelock — by design. The point of pluggable
    ///      lists is fast swap (e.g. switch to Chainalysis when it lands on
    ///      Tron) and a one-tx kill switch (`setSanctionsList(0)`) if a list
    ///      misbehaves. Multi-sig consensus is the gate.
    function setSanctionsList(address newList) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address prev = sanctionsList;
        sanctionsList = newList;
        emit SanctionsListUpdated(prev, newList);
    }

    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(this), "Cannot withdraw IDRP token");
        require(to != address(0), "Invalid recipient address");
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    // OZ v4: _beforeTokenTransfer bukan _update
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        if (frozen[from]) revert FrozenAccount();
        if (to != address(0) && frozen[to]) revert FrozenAccount();

        // Sanctions check fires only on regular transfers (not mint/burn) and
        // only when a list is wired. Cached locally so we pay one warm SLOAD
        // instead of two when wired. Kept out of the mint/burn paths so admin
        // operations (and the depositoryWallet) aren't double-charged.
        if (from != address(0) && to != address(0)) {
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

        super._beforeTokenTransfer(from, to, amount);
    }
}

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

/// @title IDRP V3 — adds on-chain sanctions enforcement via external registry
/// @notice Standalone V3 implementation. Storage layout is identical to V2 with
///         a single appended slot (`sanctionsRegistry`) — UUPS upgrade safe.
///         The OZ upgrades plugin validates compat via the annotation below.
/// @custom:oz-upgrades-from IDRP
interface ISanctionsRegistry {
    function isSanctioned(address addr) external view returns (bool);
}

contract IDRPV3 is
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

    // ── V1 storage (unchanged) ───────────────────────────────────────────────
    mapping(address => bool) public frozen;
    address public depositoryWallet;
    uint256 public maxSupply;

    // ── V2 storage (unchanged) ───────────────────────────────────────────────
    address public upgrader;

    // Upgrade timelock
    uint256 public constant UPGRADE_DELAY = 48 hours;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;

    // ── V3 storage (NEW — appended only) ─────────────────────────────────────
    /// @notice Optional external sanctions registry. When zero, the contract is
    ///         in advisory-only mode (no on-chain enforcement). When set, every
    ///         non-mint, non-burn transfer pays one STATICCALL per side.
    address public sanctionsRegistry;

    /// @dev Events (V1 + V2)
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

    /// @dev V3 events
    event SanctionsRegistryUpdated(
        address indexed previousRegistry,
        address indexed newRegistry
    );

    /// @dev Errors (V1 + V2)
    error FrozenAccount();
    error NotUpgrader();

    /// @dev V3 errors
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
        _grantRole(PAUSER_ROLE, superAdmin);
        _grantRole(MINTER_ROLE, superAdmin);
        _grantRole(FREEZER_ROLE, superAdmin);

        upgrader = superAdmin;
        emit UpgraderUpdated(address(0), superAdmin);
    }

    /// @notice One-time migration for proxies originally deployed with UPGRADER_ROLE.
    /// @dev See V2 for full doc. Carried over verbatim so V2→V3 upgrades that
    ///      have not yet run V2 migration can still complete it.
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

    /// @notice Mint stablecoins to the depository wallet.
    /// @dev Mint path is intentionally NOT gated by the sanctions registry —
    ///      mint is gated by MINTER_ROLE + the depositoryWallet check, and
    ///      the depositoryWallet is a cold wallet under the issuer's control.
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

    function setMaxSupply(
        uint256 _maxSupply
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldMaxSupply = maxSupply;
        maxSupply = _maxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, _maxSupply);
    }

    /// @notice Burn stablecoins from a specific address. Burn path skips the
    ///         sanctions check by design — burning a sanctioned wallet should
    ///         remain possible (it's how seized funds are taken out of supply).
    function burn(
        address from,
        uint256 amount
    ) public onlyRole(MINTER_ROLE) whenNotPaused {
        if (frozen[from]) revert FrozenAccount();

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

    function freeze(address account) external onlyRole(FREEZER_ROLE) {
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    function unfreeze(address account) external onlyRole(FREEZER_ROLE) {
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    function setDepositoryWallet(
        address wallet
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(wallet != address(0), "Invalid wallet address");
        address oldWallet = depositoryWallet;
        depositoryWallet = wallet;
        emit DepositoryWalletUpdated(oldWallet, wallet);
    }

    // ─── V3: Sanctions Registry wiring ───────────────────────────────────────

    /// @notice Point IDRP at a sanctions registry. Set to address(0) to disable
    ///         on-chain enforcement (advisory-only mode).
    /// @dev NOT behind the 48h timelock — by design. The whole reason for the
    ///      separate-registry architecture is to swap registries quickly when
    ///      Chainalysis ships on Kaia/Tron, or to flip the kill switch
    ///      (`setSanctionsRegistry(0)`) if a misbehaving registry blocks
    ///      legitimate transfers. Multi-sig consensus is the gate.
    function setSanctionsRegistry(
        address newRegistry
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address prev = sanctionsRegistry;
        sanctionsRegistry = newRegistry;
        emit SanctionsRegistryUpdated(prev, newRegistry);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // V1/V2 freeze check + zero-value guard for regular transfers
        if (from != address(0) && to != address(0)) {
            if (frozen[from] || frozen[to]) revert FrozenAccount();
            require(value > 0, "Transfer amount must be greater than zero");

            // V3: sanctions check (only when registry is wired). Cached to a
            // local so we pay one cold-address SLOAD instead of two.
            address registry = sanctionsRegistry;
            if (registry != address(0)) {
                if (ISanctionsRegistry(registry).isSanctioned(from)) {
                    revert SanctionedSender(from);
                }
                if (ISanctionsRegistry(registry).isSanctioned(to)) {
                    revert SanctionedRecipient(to);
                }
            }
        }
        super._update(from, to, value);
    }

    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(this), "Cannot withdraw IDRP token");
        IERC20(token).safeTransfer(to, amount);
    }
}

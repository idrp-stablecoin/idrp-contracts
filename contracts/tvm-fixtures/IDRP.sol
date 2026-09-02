// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.  Regenerate with:
//     npx hardhat run scripts/tvm/make-fixtures.ts
//
// Source: contracts/IDRP.sol
// The ONLY changes vs that source are:
//   - UPGRADE_DELAY shortened to 60 seconds so a local TVM
//     rehearsal can actually run (the real sources keep 48 hours)
//   - relative imports rewritten one directory level up
//   - the contract DECLARATION renamed with a "Tvm" suffix (declaration
//     line only — string literals are untouched, so DOMAIN_SEPARATOR is unchanged)
// Generation fails if anything else would differ.
// ─────────────────────────────────────────────────────────────────────────────
// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.22;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {TronGaplessUUPSUpgradeable} from "../utils/TronGaplessUUPSUpgradeable.sol";
import {LegacyAccessControlSlots} from "../utils/LegacyAccessControlSlots.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal interface IDRP needs from a sanctions list. Matches the
///         Chainalysis SanctionsList ABI exactly so we can point at theirs on
///         chains they support, and at our own clone on Kaia.
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

contract IDRPTvm is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    LegacyAccessControlSlots,
    ERC20PermitUpgradeable,
    TronGaplessUUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // v3 (no-access-control) authority model:
    //   admin       — single-address slot for config setters; should be Safe.
    //   controller  — single-address slot for operational calls (mint/burn/freeze/
    //                 pause/unpause); wired to the IDRPController proxy.
    //   upgrader    — single-address slot for upgrade authority + 48h timelock.
    // No roles, no AccessControlUpgradeable. Migration from the v2 source
    // (`upgrader`-only) happens via `initializeV3` (reinitializer(3), onlyUpgrader).

    /// @dev Preserved storage namespace of the removed AccessControlUpgradeable
    ///      parent. OZ Upgrades requires the namespace to remain declared so
    ///      v2→v3 layout comparison passes; the namespace still holds legacy
    ///      role-membership data (DEFAULT_ADMIN_ROLE granted to the Safe at v1
    ///      deploy time) but is no longer read by any path in v3.
    ///
    ///      DO NOT REMOVE this struct. If a future version ever re-inherits
    ///      AccessControlUpgradeable, the legacy entries in this namespace will
    ///      silently regain effect — audit the holder set first via event replay
    ///      (see scripts/list-upgrader-holders.ts for the existing pattern).
    /// @custom:storage-location erc7201:openzeppelin.storage.AccessControl
    struct AccessControlStorageDeprecated {
        mapping(bytes32 role => RoleDataDeprecated) _roles;
    }
    struct RoleDataDeprecated {
        mapping(address => bool) hasRole;
        bytes32 adminRole;
    }

    // Mapping to track frozen accounts
    // Final alignment for the deployed Tron layout. The live proxies keep the
    // token's own variables at slots 504-510; the inherited stack above ends at
    // 453, so 50 slots of padding put `frozen` on 504. Verified against Tron
    // mainnet and Nile. Do not remove, reorder, or resize.
    uint256[50] private __legacyTailGap;

    mapping(address => bool) public frozen;

    address public depositoryWallet;
    uint256 public maxSupply;

    // Single-address upgrader
    address public upgrader;

    // Upgrade timelock
    uint256 public constant UPGRADE_DELAY = 60 seconds;
    uint256 public upgradeScheduledAt;
    address public scheduledImplementation;

    /// @notice Optional external sanctions list (Chainalysis SanctionsList ABI).
    ///         When zero, no on-chain enforcement (advisory mode). When set,
    ///         every non-mint, non-burn transfer pays one STATICCALL per side.
    ///         Appended at the end of storage on purpose — UUPS layout safe.
    address public sanctionsList;

    // ─────────────────────────────────────────────────────────────────────────
    // v3: single-entity authority model (no-access-control refactor)
    // Both slots are appended at the end of sequential storage — UUPS-safe for
    // existing v1/v2 proxies (zero-initialized post-upgrade, populated via
    // initializeV3).
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Single-address admin (replaces DEFAULT_ADMIN_ROLE).
    ///         Gates config setters and rotation of the other authority slots.
    ///         Should be a Safe/multisig in production (see no-access-control
    ///         plan §4 — not enforced on-chain by design).
    address public admin;

    /// @notice Single-address operational entity (replaces MINTER_ROLE /
    ///         PAUSER_ROLE / FREEZER_ROLE). Always the IDRPController proxy.
    ///         Wired post-deploy via `setController` (Controller is deployed
    ///         after IDRP). While `address(0)`, the `onlyController` modifier
    ///         reverts `ControllerNotSet` — operational methods are inert.
    address public controller;

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
    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event ControllerUpdated(
        address indexed oldController,
        address indexed newController
    );

    /// @dev Errors
    error FrozenAccount();
    error NotUpgrader();
    error NotAdmin();
    error NotController();
    error ControllerNotSet();
    error SanctionedSender(address sender);
    error SanctionedRecipient(address recipient);

    /// @dev Modifiers
    modifier onlyUpgrader() {
        if (_msgSender() != upgrader) revert NotUpgrader();
        _;
    }

    modifier onlyAdmin() {
        if (_msgSender() != admin) revert NotAdmin();
        _;
    }

    /// @dev Reverts ControllerNotSet while `controller` is the zero address, so
    ///      operational methods are inert between deploy and `setController`.
    modifier onlyController() {
        if (controller == address(0)) revert ControllerNotSet();
        if (_msgSender() != controller) revert NotController();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Fresh-deploy initializer. Wires `admin` = `upgrader` =
    ///         `superAdmin`; `controller` is wired post-deploy via
    ///         `setController` once the IDRPController proxy exists.
    function initialize(address superAdmin) public initializer {
        require(superAdmin != address(0), "Invalid superAdmin");
        __ERC20_init("IDRP", "IDRP");
        __ERC20Pausable_init();
        __ERC20Permit_init("IDRP");
        __UUPSUpgradeable_init();

        admin = superAdmin;
        emit AdminUpdated(address(0), superAdmin);

        upgrader = superAdmin;
        emit UpgraderUpdated(address(0), superAdmin);
        // `controller` stays address(0); wired post-deploy via setController.
    }

    /// @notice One-time v2→v3 migration: wires `admin` and `controller`,
    ///         optionally rotates `upgrader`.
    /// @dev Gated by `onlyUpgrader` because every chain that's at v2 has the
    ///      upgrader slot populated. reinitializer(3) blocks replay.
    /// @param _admin       New admin (Safe).
    /// @param _controller  IDRPController proxy address.
    /// @param _upgrader    New upgrader (may equal current).
    function initializeV3(
        address _admin,
        address _controller,
        address _upgrader
    ) external reinitializer(3) onlyUpgrader {
        require(_admin != address(0), "Invalid admin");
        require(_controller != address(0), "Invalid controller");
        require(_upgrader != address(0), "Invalid upgrader");

        address oldUpgrader = upgrader;
        admin = _admin;
        controller = _controller;
        upgrader = _upgrader;

        emit AdminUpdated(address(0), _admin);
        emit ControllerUpdated(address(0), _controller);
        emit UpgraderUpdated(oldUpgrader, _upgrader);
    }

    /// @notice Rotate the single upgrader address. Only `admin` (Safe) may rotate.
    function setUpgrader(address _upgrader) external onlyAdmin {
        require(_upgrader != address(0), "Invalid upgrader");
        address oldUpgrader = upgrader;
        upgrader = _upgrader;
        emit UpgraderUpdated(oldUpgrader, _upgrader);
    }

    /// @notice Rotate the admin address. Only the current `admin` may rotate.
    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "Invalid admin");
        address oldAdmin = admin;
        admin = _admin;
        emit AdminUpdated(oldAdmin, _admin);
    }

    /// @notice Rotate the controller address. Only `admin` may rotate.
    /// @dev Rejects `address(0)` — rotation only goes address→address; the unset
    ///      state can only exist between deploy and the first `setController` /
    ///      `initializeV3` call.
    function setController(address _controller) external onlyAdmin {
        require(_controller != address(0), "Invalid controller");
        address oldController = controller;
        controller = _controller;
        emit ControllerUpdated(oldController, _controller);
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

    function pause() public onlyController {
        _pause();
    }

    function unpause() public onlyController {
        _unpause();
    }

    /// @notice Mint stablecoins to a specific address
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
    function setMaxSupply(uint256 _maxSupply) external onlyAdmin {
        uint256 oldMaxSupply = maxSupply;
        maxSupply = _maxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, _maxSupply);
    }

    /// @notice Burn stablecoins from the controller's own balance or from the
    ///         depository cold wallet.
    /// @param from MUST be either the calling controller itself or the
    ///             configured depositoryWallet. Any other source reverts —
    ///             third-party balances are NOT burnable from this entry point.
    /// @param amount The amount of stablecoins to burn.
    /// @dev Burn-consent invariant: third-party balances cannot be destroyed
    ///      from this entry point. The off-ramp pattern is "user transfers to
    ///      controller, controller burns from itself" for user redemptions, or
    ///      "controller burns from depository" for protocol-managed cold balances.
    ///
    ///      Authorization layering:
    ///        1. onlyController — only the wired IDRPController proxy can call.
    ///        2. whenNotPaused.
    ///        3. frozen[from] check — burning a frozen account reverts.
    ///        4. from MUST be controller or depositoryWallet, else revert.
    function burn(
        address from,
        uint256 amount
    ) public onlyController whenNotPaused {
        if (frozen[from]) revert FrozenAccount();

        // onlyController already guarantees _msgSender() == controller, so the
        // first leg of the predicate below is equivalent to "from is the
        // controller's own balance." The second leg covers the cold wallet.
        // - depositoryWallet is a cold wallet (cannot sign, cannot approve).
        // - controller funds itself via user transfers before calling burn.
        if (from != _msgSender() && from != depositoryWallet) {
            revert("Only controller or depository wallet can burn tokens");
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
    /// @dev Rejects a no-op set to the current wallet so a no-op update cannot
    ///      silently emit a misleading event.
    function setDepositoryWallet(address wallet) external onlyAdmin {
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
    ///      misbehaves. Multi-sig consensus (admin = Safe) is the gate.
    function setSanctionsList(address newList) external onlyAdmin {
        address prev = sanctionsList;
        sanctionsList = newList;
        emit SanctionsListUpdated(prev, newList);
    }

    // OZ 4.x hook. OZ 5 replaced _beforeTokenTransfer with _update; on Tron we stay
    // on OZ 4 because the deployed proxies use its sequential storage layout, so the
    // freeze/sanctions gate lives here instead. Same position in the transfer path:
    // both run before balances move, and ERC20Pausable enforces whenNotPaused here too.
    function _beforeTokenTransfer(
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
        super._beforeTokenTransfer(from, to, value);
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

    /// @notice ERC-2612 permit with an explicit freeze gate.
    /// @dev Reverts when either the owner or the spender is frozen, so a frozen
    ///      account cannot set allowances. Token movement is independently gated
    ///      by the freeze checks in _beforeTokenTransfer().
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public override {
        if (frozen[owner] || frozen[spender]) revert FrozenAccount();
        super.permit(owner, spender, value, deadline, v, r, s);
    }
}

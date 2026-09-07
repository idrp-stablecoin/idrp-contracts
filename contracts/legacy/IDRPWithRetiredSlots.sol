// SPDX-License-Identifier: MIT
// LAYOUT FIXTURE — the variant that RESERVED the retired confiscation slots
// with __deprecated_* placeholders (branch feat/confiscate-to-depository).
// Only Kairos and Base Sepolia ever ran it.
// Kept so the test suite can prove that upgrading FROM it into the
// placeholder-free layout is rejected by the validator — which is precisely why
// those two testnets need fresh proxies rather than an upgrade.
// Never deployed from here.
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.22;

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

contract IDRPWithRetiredSlots is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable
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

    // ─────────────────────────────────────────────────────────────────────────
    // Confiscation (seizure of a frozen account's balance)
    //
    // Seized funds go to `depositoryWallet`; there is no separate destination
    // slot. The three `__deprecated_*` placeholders below are the retired
    // destination slots, RESERVED rather than deleted.
    //
    // They cannot be deleted. A live proxy already holds a nonzero address in
    // the first of them, and `_inConfiscation` is packed into that same slot at
    // byte 20. Removing the address would slide the flag down to byte 0, where
    // it would read that address's low byte as `true` — permanently disabling
    // the freeze gate in `_update` for every transfer, with every test still
    // green. Never reuse these slots; append new state strictly after them.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Retired: the standalone confiscation destination. Reserved to hold
    ///      `_inConfiscation` at byte 20 of this slot — see the note above.
    /// @custom:oz-renamed-from confiscationWallet
    address private __deprecated_confiscationWallet;

    /// @dev Set for the duration of a `confiscate` call so `_update` skips the
    ///      freeze + sanctions gate. That bypass is the entire point: we are
    ///      moving funds out of an account those gates exist to immobilize, and
    ///      away from an address a sanctions list may well name.
    ///
    ///      Lives at byte 20 of the reserved slot above and MUST STAY THERE.
    ///      Its position is load-bearing: see the storage note above.
    ///
    ///      NEVER expose a setter for this. It is set and cleared inside a
    ///      single external call and is not readable between transactions.
    bool private _inConfiscation;

    /// @dev Retired: pending half of the destination timelock. Reserved.
    /// @custom:oz-renamed-from pendingConfiscationWallet
    address private __deprecated_pendingConfiscationWallet;

    /// @dev Retired: schedule timestamp of the destination timelock. Reserved.
    /// @custom:oz-renamed-from confiscationWalletScheduledAt
    uint256 private __deprecated_confiscationWalletScheduledAt;

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
    /// @notice Emitted on every seizure. This is the audit trail a regulator or a
    ///         disputing user reads — it must name the source, the destination
    ///         and the amount, and it must accompany exactly one Transfer event.
    ///
    ///         Load-bearing for attestation. Seized funds now land in the same
    ///         wallet `mint` credits, so the depository's on-chain balance no
    ///         longer distinguishes reserve from seizure. Summing this event is
    ///         what splits them; nothing else does.
    event AssetsConfiscated(
        address indexed from,
        address indexed to,
        uint256 amount
    );

    /// @dev Errors
    error FrozenAccount();
    error NotUpgrader();
    error NotAdmin();
    error NotController();
    /// @dev Thrown by `confiscate` when the target isn't frozen — see that
    ///      function's NatSpec for why this precondition is hard.
    error NotFrozen();
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

    /// @notice Seize a frozen account's balance into the depository wallet.
    /// @param from   The frozen account to seize from.
    /// @param amount The amount to seize. Partial seizure is allowed.
    /// @dev Requires: onlyController quorum (Officer+Manager+Director+Commissioner
    ///      for OperationType.Confiscate), whenNotPaused, depositoryWallet set,
    ///      and frozen[from] as a hard precondition (freeze first, then seize;
    ///      not auto-unfrozen after). Implemented as a transfer to the depository,
    ///      never a burn, so total supply is conserved and the seizure stays reversible.
    ///
    ///      The destination is `depositoryWallet` — the same address `mint`
    ///      credits — so it is NOT segregated on-chain and moves whenever
    ///      `setDepositoryWallet` moves. That setter is `onlyAdmin` and instant,
    ///      so admin alone chooses where a seizure lands; the quorum still
    ///      decides whether one happens at all. Segregation is off-chain, via
    ///      the `AssetsConfiscated` event.
    function confiscate(
        address from,
        uint256 amount
    ) external onlyController whenNotPaused {
        address destination = depositoryWallet;
        require(destination != address(0), "Depository wallet not set");
        if (!frozen[from]) revert NotFrozen();
        require(amount > 0, "Amount must be greater than zero");
        // No frozen-destination check here, deliberately: the pre-removal code
        // had none either, and adding one would block a seizure exactly when it
        // is most needed. If one is ever added it must go AFTER this line —
        // confiscate requires frozen[from], so on a self-seizure the destination
        // is frozen by construction and would mask this more specific error.
        require(from != destination, "Cannot confiscate from the depository");

        // Bypass the freeze/sanctions gate in _update for this transfer only.
        _inConfiscation = true;
        _transfer(from, destination, amount);
        _inConfiscation = false;

        emit AssetsConfiscated(from, destination, amount);
    }

    /// @notice Set the depository wallet address
    /// @param wallet The address of the depository wallet
    /// @dev Rejects a no-op set to the current wallet so a no-op update cannot
    ///      silently emit a misleading event.
    ///
    ///      This setter now also chooses where `confiscate` sends seized funds.
    ///      It stays instant and un-timelocked because `mint` needs it during
    ///      bootstrap; the `address(this)` guard below is inherited from the
    ///      retired destination setter, where it stopped funds being sent
    ///      somewhere `withdrawToken` cannot recover them.
    function setDepositoryWallet(address wallet) external onlyAdmin {
        require(wallet != address(0), "Invalid wallet address");
        require(wallet != depositoryWallet, "Same wallet");
        require(wallet != address(this), "Cannot be the token contract");
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

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Freeze + sanctions checks only on regular transfers (not mint/burn).
        //
        // `_inConfiscation` is read INSIDE the frozen branch, not in this outer
        // condition, so ordinary transfers between two unfrozen accounts — which
        // is every normal transfer, forever, on six live chains — never touch
        // its storage slot. `confiscate` hard-requires `frozen[from]`, so a
        // seizure always lands in the frozen branch below and the flag is
        // always checked there; this restructuring changes nothing about when
        // a seizure is allowed to bypass the gate, only where in the code that
        // check happens.
        if (from != address(0) && to != address(0)) {
            if (frozen[from] || frozen[to]) {
                // Only a confiscation may move value on a frozen account.
                //
                // `_inConfiscation` is set only inside `confiscate()`, for the
                // duration of one internal _transfer, and cleared before that
                // call returns. It is never true across transactions and has no
                // setter. Skipping the revert is the entire point of a seizure:
                // the funds are in an account the freeze gate exists to
                // immobilize.
                if (!_inConfiscation) revert FrozenAccount();
            } else {
                require(value > 0, "Transfer amount must be greater than zero");

                // Sanctions check fires only when a list is wired. Cached
                // locally so we pay one warm SLOAD instead of two when wired.
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

    /// @notice ERC-2612 permit with an explicit freeze gate.
    /// @dev Reverts when either the owner or the spender is frozen, so a frozen
    ///      account cannot set allowances. Token movement is independently gated
    ///      by the freeze checks in _update().
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

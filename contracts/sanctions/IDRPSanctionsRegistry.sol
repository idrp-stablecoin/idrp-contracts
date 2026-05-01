// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title IDRPSanctionsRegistry
/// @notice Standalone, non-upgradeable on-chain sanctions registry for IDRP.
contract IDRPSanctionsRegistry is AccessControl {
    // Multisig: single ops + governance. Keeper: routine batch sync.
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // Sanction category codes — kept identical across all chain deployments.
    uint8 public constant CAT_UNCATEGORIZED = 0;
    uint8 public constant CAT_UN_DESIGNATED = 1;
    uint8 public constant CAT_LAW_ENFORCEMENT = 2;
    uint8 public constant CAT_CRIMINAL_RANSOMWARE = 3;
    uint8 public constant CAT_CRIMINAL_SCAM_THEFT = 4;
    uint8 public constant CAT_CRIMINAL_DARKNET = 5;
    uint8 public constant CAT_FOREIGN_GOV_LIST = 6;
    uint8 public constant CAT_OJK_DOMESTIC = 7;
    uint8 public constant CAT_OFAC_SDN = 8;

    uint256 public constant MAX_BATCH_SIZE = 500;

    struct SanctionEntry {
        bool isSanctioned;
        uint8 category;
        uint64 addedAt;
        string source;
    }

    mapping(address => SanctionEntry) private _entries;
    uint256 public sanctionedCount;

    event SanctionedAddress(address indexed addr);
    event NonSanctionedAddress(address indexed addr);

    // Extended events with provenance.
    event SanctionedAddressAdded(
        address indexed addr,
        uint8 category,
        string source,
        uint64 addedAt
    );
    event SanctionedAddressRemoved(address indexed addr);
    event BatchAdded(uint256 count, uint8 category, string source);
    event BatchRemoved(uint256 count);

    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);

    constructor(address multisig, address keeper) {
        _grantRole(DEFAULT_ADMIN_ROLE, multisig);
        _grantRole(MULTISIG_ROLE, multisig);
        _grantRole(KEEPER_ROLE, keeper);
    }

    function name() external pure returns (string memory) {
        return "IDRP Sanctions Registry v1";
    }

    function isSanctioned(address addr) external view returns (bool) {
        return _entries[addr].isSanctioned;
    }

    function isSanctionedVerbose(address addr)
        external
        view
        returns (bool sanctioned, uint8 category, string memory source)
    {
        SanctionEntry storage e = _entries[addr];
        return (e.isSanctioned, e.category, e.source);
    }

    function getEntry(address addr) external view returns (SanctionEntry memory) {
        return _entries[addr];
    }

    function addSanctioned(
        address addr,
        uint8 category,
        string calldata source
    ) external onlyRole(MULTISIG_ROLE) {
        bool wasNew = _addOne(addr, category, source);
        if (wasNew) emit SanctionedAddress(addr);
        emit SanctionedAddressAdded(addr, category, source, uint64(block.timestamp));
    }

    function removeSanctioned(address addr) external onlyRole(MULTISIG_ROLE) {
        if (_removeOne(addr)) {
            emit NonSanctionedAddress(addr);
            emit SanctionedAddressRemoved(addr);
        }
    }

    function batchAddSanctioned(
        address[] calldata addrs,
        uint8 category,
        string calldata source
    ) external onlyRole(KEEPER_ROLE) {
        uint256 len = addrs.length;
        if (len == 0) revert EmptyBatch();
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge(len, MAX_BATCH_SIZE);

        uint64 ts = uint64(block.timestamp);
        for (uint256 i; i < len; ) {
            address a = addrs[i];
            bool wasNew = _addOne(a, category, source);
            if (wasNew) emit SanctionedAddress(a);
            emit SanctionedAddressAdded(a, category, source, ts);
            unchecked {
                ++i;
            }
        }
        emit BatchAdded(len, category, source);
    }

    function batchRemoveSanctioned(address[] calldata addrs) external onlyRole(KEEPER_ROLE) {
        uint256 len = addrs.length;
        if (len == 0) revert EmptyBatch();
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge(len, MAX_BATCH_SIZE);

        uint256 actuallyRemoved;
        for (uint256 i; i < len; ) {
            address a = addrs[i];
            if (_removeOne(a)) {
                emit NonSanctionedAddress(a);
                emit SanctionedAddressRemoved(a);
                unchecked {
                    ++actuallyRemoved;
                }
            }
            unchecked {
                ++i;
            }
        }
        emit BatchRemoved(actuallyRemoved);
    }


    /// @dev Returns true if this address transitioned from not-sanctioned to sanctioned.
    function _addOne(address addr, uint8 category, string calldata source) internal returns (bool wasNew) {
        SanctionEntry storage e = _entries[addr];
        wasNew = !e.isSanctioned;
        if (wasNew) {
            e.isSanctioned = true;
            unchecked {
                ++sanctionedCount;
            }
        }
        e.category = category;
        e.addedAt = uint64(block.timestamp);
        e.source = source;
    }

    /// @dev Returns true if this address transitioned from sanctioned to not-sanctioned.
    function _removeOne(address addr) internal returns (bool wasRemoved) {
        if (_entries[addr].isSanctioned) {
            delete _entries[addr];
            unchecked {
                --sanctionedCount;
            }
            return true;
        }
        return false;
    }
}

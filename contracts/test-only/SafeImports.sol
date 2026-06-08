// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// TEST-ONLY: forces Hardhat to compile the Safe contracts so they're
// available via getContractFactory("Safe") / getContractFactory("SafeProxyFactory")
// in test/IDRPWithSafe.ts. NOT deployed to production.
import "@safe-global/safe-contracts/contracts/Safe.sol";
import "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";

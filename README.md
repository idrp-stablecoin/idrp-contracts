# IDRP Stablecoin

IDRP is a stablecoin pegged to the Indonesian Rupiah (IDR). It is an ERC-20 token with additional features such as upgradability, pausing, freezing, and minting/burning capabilities.

## Features

- **ERC-20 Compliant**: Fully compatible with Ethereum-based wallets and smart contracts.
- **Upgradeable**: Uses OpenZeppelin's UUPS upgrade pattern to support future enhancements.
- **Minting & Burning**: Only authorized accounts (`MINTER_ROLE`) can mint and burn tokens.
- **Pausing**: Transactions can be paused by accounts with the `PAUSER_ROLE`.
- **Freezing**: Specific accounts can be frozen to prevent transfers.
- **Permit (EIP-2612)**: Supports gasless approvals via signatures.

## Smart Contract Overview

The IDRP contract is built using OpenZeppelin’s upgradeable contracts and consists of:

### Roles

- `DEFAULT_ADMIN_ROLE`: Manages role assignments.
- `PAUSER_ROLE`: Can pause and unpause the contract.
- `MINTER_ROLE`: Can mint and burn tokens.
- `FREEZER_ROLE`: Can freeze and unfreeze accounts.
- `UPGRADER_ROLE`: Can upgrade the contract implementation.

### Main Functions

- `initialize(string name, string symbol)`: Initializes the contract.
- `mint(address to, uint256 amount)`: Mints tokens to a specified address.
- `burn(address from, uint256 amount)`: Burns tokens from a specified address.
- `pause()` / `unpause()`: Pauses/unpauses token transfers.
- `freeze(address account)`: Freezes a specified account.
- `unfreeze(address account)`: Unfreezes a specified account.
- `transfer(address to, uint256 amount)`: Transfers tokens with additional security checks.
- `transferFrom(address from, address to, uint256 amount)`: Transfers tokens on behalf of another account.

## Deployment

Since this contract is upgradeable, it should be deployed using a proxy pattern. You can use OpenZeppelin's Upgrades Plugin to deploy and manage upgrades.

### IDRP

```sh
npx hardhat run scripts/deploy.ts --network <your-network>
```

### IDRP Controller

```sh
npx hardhat run scripts/deploy-controller.ts --network <your-network>
```

### Initial Setup
- run controller setup script after deploying both contracts
    ```sh
    npx hardhat run scripts/setup-controller.ts --network <your-network>
    ```
- hit `setDepository` on IDRP contract, to set depository address.

## Security Considerations

- **Only authorized roles should be assigned to trusted entities.**
- **Frozen accounts cannot receive or send tokens.**
- **Upgrades should be carefully reviewed before deployment.**

## License

This project is licensed under the MIT License.

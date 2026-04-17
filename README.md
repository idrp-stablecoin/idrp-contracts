# IDRP Stablecoin

IDRP is a stablecoin pegged to the Indonesian Rupiah (IDR). It is an ERC-20 token with additional features such as upgradability, pausing, freezing, and minting/burning capabilities. The IDRP contract is built using OpenZeppelin’s upgradeable contracts and consists of:

### Roles

- `DEFAULT_ADMIN_ROLE`: Manages role assignments and rotates the single `upgrader`.
- `PAUSER_ROLE`: Can pause and unpause the contract.
- `MINTER_ROLE`: Can mint and burn tokens.
- `FREEZER_ROLE`: Can freeze and unfreeze accounts.
- `upgrader` (single address, not a role): Can authorize UUPS upgrades. Rotated by
  `DEFAULT_ADMIN_ROLE` via `setUpgrader(address)`. Replaces the legacy
  `UPGRADER_ROLE` following the security audit (C-1) — admin/upgrader
  authority is now bound to exactly one address at a time, while operational
  roles (pauser/minter/freezer/controller TAP roles) remain multi-address.

### Main Functions

- `initialize(string name, string symbol)`: Initializes the contract.
- `mint(address to, uint256 amount)`: Mints tokens to a specified address.
- `burn(address from, uint256 amount)`: Burns tokens from a specified address.
- `pause()` / `unpause()`: Pauses/unpauses token transfers.
- `freeze(address account)`: Freezes a specified account.
- `unfreeze(address account)`: Unfreezes a specified account.
- `transfer(address to, uint256 amount)`: Transfers tokens with additional security checks.
- `transferFrom(address from, address to, uint256 amount)`: Transfers tokens on behalf of another account.

## Smart Contract Architecture

The documentation for the smart contract architecture can be read [here](./docs/arch/3.SMART_CONTRACT_ARCH.md).

## Smart Contract Bussiness Process

The documentation for the smart contract bussiness process can be read [here](./docs/bussiness-proccess/SMART_CONTRACT_BUSSINESS_PROCESS.md).


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
